import type {
  ArchiveRecord, FieldChoice, FieldKey, MatchCandidate, PendingFieldChoices, PendingMerge
} from '../types';

/** 九个字段的固定顺序，待定队列与审计都以它为准 */
export const FIELD_KEYS: FieldKey[] = [
  'title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'
];

const normalize = (value: string) => value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');
const chars = (value: string) => {
  const text = normalize(value);
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
};
const dice = (left: string, right: string) => {
  const a = chars(left);
  const b = chars(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let hits = 0;
  a.forEach((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { hits += 1; remaining.splice(index, 1); }
  });
  return (2 * hits) / (a.length + b.length);
};
const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
};
const exactish = (left: string, right: string) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  return dice(a, b);
};
const displayValue = (record: ArchiveRecord, field: FieldKey) => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value);
};

export function scorePair(left: ArchiveRecord, right: ArchiveRecord) {
  const fieldScores: Record<FieldKey, number> = {
    title: exactish(left.title, right.title),
    date: exactish(left.date, right.date),
    people: jaccard(left.people, right.people),
    places: jaccard(left.places, right.places),
    identifier: exactish(left.identifier, right.identifier),
    medium: exactish(left.medium, right.medium),
    extent: exactish(left.extent, right.extent),
    rights: exactish(left.rights, right.rights),
    notes: exactish(left.notes, right.notes)
  };
  const score = fieldScores.title * .3 + fieldScores.date * .2 + fieldScores.people * .2 + fieldScores.places * .14 + fieldScores.identifier * .16;
  const reasons: string[] = [];
  if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  if (fieldScores.title > .58) reasons.push('标题相似');
  if (fieldScores.date > .9) reasons.push('日期一致');
  if (fieldScores.people > .8) reasons.push('人物一致');
  if (fieldScores.places > .6) reasons.push('地点相近');
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return { score: Math.min(1, score), fieldScores, reasons };
}

export function computeMatches(records: ArchiveRecord[]): MatchCandidate[] {
  const left = records.filter((record) => record.group === 'A');
  const right = records.filter((record) => record.group === 'B');
  const matches: MatchCandidate[] = [];
  left.forEach((a) => {
    const candidates = right.map((b) => ({ record: b, ...scorePair(a, b) }))
      .filter((item) => item.score >= .38)
      .sort((x, y) => y.score - x.score)
      .slice(0, 4);
    candidates.forEach((candidate) => {
      matches.push({
        id: `match-${a.id}-${candidate.record.id}`,
        leftId: a.id,
        rightId: candidate.record.id,
        score: candidate.score,
        fieldScores: candidate.fieldScores,
        status: 'suggested',
        reasons: candidate.reasons
      });
    });
  });
  return matches.sort((a, b) => b.score - a.score);
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}

/** 取值来源对应的字段内容；combine 时用分号拼接两侧 */
export function chosenFieldValue(left: ArchiveRecord, right: ArchiveRecord, field: FieldKey, choice: FieldChoice): string {
  if (choice === 'combine') {
    const a = fieldValue(left, field);
    const b = fieldValue(right, field);
    return [a, b].filter(Boolean).join('；') || '';
  }
  return fieldValue(choice === 'A' ? left : right, field);
}

/** 两侧取值不同、必须由用户拍板保留来源的字段 */
export function conflictFields(left: ArchiveRecord, right: ArchiveRecord): FieldKey[] {
  return FIELD_KEYS.filter((field) => fieldValue(left, field) !== fieldValue(right, field));
}

/** 暂存选择里仍缺来源的字段（即未决冲突） */
export function unresolvedFields(choices: PendingFieldChoices): FieldKey[] {
  return FIELD_KEYS.filter((field) => choices[field] === undefined);
}

export interface QueueOccupant {
  pending: PendingMerge;
  sharedRecordId: string;
}

/**
 * 同一条记录不能同时进入两个配对：返回 queue 中已占用 leftId/rightId 的待定项。
 * excludePendingId 用于编辑队列内已有项时排除自身。
 */
export function findQueueOccupant(
  queue: PendingMerge[],
  leftId: string,
  rightId: string,
  excludePendingId?: string
): QueueOccupant | undefined {
  for (const pending of queue) {
    if (pending.id === excludePendingId) continue;
    if (pending.leftId === leftId || pending.rightId === leftId) return { pending, sharedRecordId: leftId };
    if (pending.leftId === rightId || pending.rightId === rightId) return { pending, sharedRecordId: rightId };
  }
  return undefined;
}

/** 把多个配对在队列内部两两占用的情况找出来，供批量提交时整批拦截 */
export function findInternalOverlap(queue: PendingMerge[]): { first: PendingMerge; second: PendingMerge; sharedRecordId: string } | undefined {
  for (let i = 0; i < queue.length; i += 1) {
    for (let j = i + 1; j < queue.length; j += 1) {
      const a = queue[i];
      const b = queue[j];
      const ids = [a.leftId, a.rightId];
      const shared = ids.find((id) => id === b.leftId || id === b.rightId);
      if (shared) return { first: a, second: b, sharedRecordId: shared };
    }
  }
  return undefined;
}

/**
 * 依据暂存的九个字段来源构造合并记录。只做纯计算，
 * 不删除原记录、不改匹配状态——副作用留给调用方在整批校验通过后统一执行。
 */
export function buildMergedRecord(
  left: ArchiveRecord,
  right: ArchiveRecord,
  choices: Partial<Record<FieldKey, FieldChoice>>,
  mergedAt: string
): { record: ArchiveRecord; values: Partial<Record<FieldKey, string>> } {
  const values: Partial<Record<FieldKey, string>> = {};
  FIELD_KEYS.forEach((field) => {
    const choice = choices[field];
    if (choice) values[field] = chosenFieldValue(left, right, field, choice);
  });
  const splitList = (field: FieldKey, fallback: string[]) =>
    values[field]?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? fallback;
  return {
    record: {
      id: crypto.randomUUID(),
      group: left.group,
      title: values.title ?? left.title,
      date: values.date ?? left.date,
      people: splitList('people', left.people),
      places: splitList('places', left.places),
      identifier: values.identifier ?? left.identifier,
      medium: values.medium ?? left.medium,
      extent: values.extent ?? left.extent,
      rights: values.rights ?? left.rights,
      notes: values.notes ?? left.notes,
      updatedAt: mergedAt,
      status: 'merged'
    },
    values
  };
}
