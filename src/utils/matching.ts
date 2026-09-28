import type {
  ArchiveRecord, FieldChoices, FieldKey, FieldSource, MatchCandidate, PendingFieldChoices, PendingMerge
} from '../types';

/** 核对台固定比对的九个字段，待定队列按此顺序逐字段暂存来源。 */
export const FIELD_KEYS: FieldKey[] = ['title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'];

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

/** 两侧展示值不同的字段即未决冲突，队列需要逐字段提示。 */
export function conflictingFields(left: ArchiveRecord, right: ArchiveRecord): FieldKey[] {
  return FIELD_KEYS.filter((field) => fieldValue(left, field) !== fieldValue(right, field));
}

/**
 * 进入待定队列时的初始来源：两侧一致的字段默认保留 A 来源（值相同不影响结果），
 * 冲突字段留空（''），强制研究者在队列中决定，避免先合错再撤销。
 */
export function defaultPendingSources(left: ArchiveRecord, right: ArchiveRecord): PendingFieldChoices {
  const sources = {} as PendingFieldChoices;
  FIELD_KEYS.forEach((field) => {
    sources[field] = fieldValue(left, field) === fieldValue(right, field) ? 'A' : '';
  });
  return sources;
}

/** 队列条目尚未选择保留来源的字段。 */
export function undecidedFields(pending: PendingMerge): FieldKey[] {
  return FIELD_KEYS.filter((field) => pending.sources[field] === '');
}

export function isReady(pending: PendingMerge): boolean {
  return undecidedFields(pending).length === 0;
}

/**
 * 判断一组配对能否进入待定队列：同一条记录不能同时出现在两个配对中。
 * 返回冲突的已暂存条目（排除自身），没有冲突时返回 undefined。
 */
export function findQueueClash(queue: PendingMerge[], leftId: string, rightId: string, excludeId?: string): PendingMerge | undefined {
  return queue.find((item) => item.id !== excludeId && (item.leftId === leftId || item.rightId === rightId || item.leftId === rightId || item.rightId === leftId));
}

/** 队列当前占用的全部记录 id。 */
export function claimedRecordIds(queue: PendingMerge[]): Set<string> {
  return new Set(queue.flatMap((item) => [item.leftId, item.rightId]));
}

export type SubmitError =
  | { kind: 'missing'; pending: PendingMerge; fields: FieldKey[] }
  | { kind: 'occupied'; pending: PendingMerge; recordId: string; by: PendingMerge }
  | { kind: 'missing-record'; pending: PendingMerge; recordId: string };

/**
 * 批量提交前的整体校验：只要有一组缺字段选择、记录已被其他提交占用
 * 或原记录已不存在，整批都不生效，按队列顺序返回第一个问题。
 * 同时检测同一批勾选内部互相占用的配对。
 */
export function validateBatch(items: PendingMerge[], records: ArchiveRecord[]): SubmitError | undefined {
  const byId = new Map(records.map((record) => [record.id, record]));
  const claimed = new Map<string, PendingMerge>();
  for (const pending of items) {
    const fields = undecidedFields(pending);
    if (fields.length) return { kind: 'missing', pending, fields };
    for (const recordId of [pending.leftId, pending.rightId]) {
      if (!byId.has(recordId)) return { kind: 'missing-record', pending, recordId };
      const holder = claimed.get(recordId);
      if (holder && holder.id !== pending.id) return { kind: 'occupied', pending, recordId, by: holder };
      claimed.set(recordId, pending);
    }
  }
  return undefined;
}

/** 按选定来源拼接单个字段的最终值。 */
export function buildMergedValues(left: ArchiveRecord, right: ArchiveRecord, sources: FieldChoices) {
  const values: Partial<Record<FieldKey, string>> = {};
  FIELD_KEYS.forEach((field) => {
    const source: FieldSource = sources[field];
    values[field] = source === 'combine'
      ? [fieldValue(left, field), fieldValue(right, field)].filter(Boolean).join('；')
      : fieldValue(source === 'A' ? left : right, field);
  });
  return values;
}

/** 由两侧原记录与已决来源生成合并后的新记录（不修改入参）。 */
export function buildMergedRecord(
  left: ArchiveRecord,
  values: Partial<Record<FieldKey, string>>,
  mergedAt: string
): ArchiveRecord {
  return {
    ...left,
    ...values,
    people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
    places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
    status: 'merged',
    updatedAt: mergedAt
  };
}
