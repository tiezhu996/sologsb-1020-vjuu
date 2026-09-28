export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'pending' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

/** 字段最终保留来源：A 组、B 组或双来源拼接 */
export type FieldSource = RecordGroup | 'combine';
/** 待定队列中的字段来源，空字符串表示该字段尚未决定，提交时整批拦截 */
export type PendingFieldSource = FieldSource | '';
export type FieldChoices = Record<FieldKey, FieldSource>;
export type PendingFieldChoices = Record<FieldKey, PendingFieldSource>;

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
}

/**
 * 待定队列条目：正式合并前，候选配对先在此暂存九个字段的保留来源。
 * sources 中任一为空字符串即“未决冲突”，批量提交时该组所在的整批都不会生效。
 * fromStatus 记录进入队列前的匹配状态，移出队列时原样恢复。
 */
export interface PendingMerge {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  sources: PendingFieldChoices;
  fromStatus: MatchStatus;
  addedAt: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  pendingMerges: PendingMerge[];
  merges: MergeResult[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
