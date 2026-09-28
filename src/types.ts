export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';
export type FieldChoice = RecordGroup | 'combine';
/** 九个字段的暂存选择；冲突字段在用户拍板前为 undefined（未决） */
export type PendingFieldChoices = Partial<Record<FieldKey, FieldChoice>>;

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

export interface MergeResult {
  id: string;
  matchId: string;
  pendingId?: string;
  leftId: string;
  rightId: string;
  /** 合并生成的新记录 id，审计里可据此回看合并结果 */
  mergedId: string;
  chosen: Partial<Record<FieldKey, FieldChoice>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
}

/**
 * 待定队列中的一条候选：正式合并前只暂存九个字段的保留来源，
 * 不改动任何原记录。choices 中缺失的字段即“未决冲突”。
 */
export interface PendingMerge {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  score: number;
  reasons: string[];
  choices: PendingFieldChoices;
  stagedAt: string;
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
  merges: MergeResult[];
  /** 正式合并前的待定队列：仅暂存字段来源，不触碰原记录 */
  pending: PendingMerge[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
