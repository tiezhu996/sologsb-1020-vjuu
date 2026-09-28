import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, FieldKey, MatchCandidate, PendingMerge, RecordGroup
} from './types';
import {
  FIELD_KEYS, buildMergedRecord, buildMergedValues, claimedRecordIds, computeMatches,
  defaultPendingSources, fieldValue, findQueueClash, isReady, undecidedFields, validateBatch
} from './utils/matching';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-state-v2';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];
const fieldLabel = (field: FieldKey) => fieldLabels.find(([key]) => key === field)?.[1] ?? field;

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const recordTitle = (state: ArchiveState, id: string) => recordById(state, id)?.title ?? id;
const matchLabel = (state: ArchiveState, match: MatchCandidate) =>
  `${recordTitle(state, match.leftId)} ↔ ${recordTitle(state, match.rightId)}`;
const pairLabel = (state: ArchiveState, leftId: string, rightId: string) =>
  `${recordTitle(state, leftId)} ↔ ${recordTitle(state, rightId)}`;
const statusLabel = (status: MatchCandidate['status']) =>
  status === 'suggested' ? '待复核'
    : status === 'confirmed' ? '已确认'
      : status === 'pending' ? '待合并'
        : status === 'rejected' ? '已忽略' : '已合并';

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | MatchCandidate['status']>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const checkedPendingIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  /** 当前编辑的待定条目 id；为空字符串时表示在为新配对暂存 */
  const editingPendingId = useSignal('');
  /** 合并弹窗中临时编辑的匹配 id，保存时写入队列，取消则丢弃 */
  const editingMatchId = useSignal('');
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  const emptyDraft = () => ({ title: '', date: '', people: '', places: '', identifier: '', medium: '', extent: '', rights: '', notes: '' }) as PendingMerge['sources'];
  const draft = useStore(emptyDraft());

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    pendingMerges: state.pendingMerges,
    merges: state.merges,
    audit: state.audit
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.pendingMerges = next.pendingMerges ?? [];
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds });
    state.audit = state.audit.slice(0, 300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
    checkedPendingIds.value = checkedPendingIds.value.filter((id) => state.pendingMerges.some((item) => item.id === id));
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
    checkedPendingIds.value = checkedPendingIds.value.filter((id) => state.pendingMerges.some((item) => item.id === id));
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);
  const claimedIds = useComputed$(() => claimedRecordIds(state.pendingMerges));
  /** 勾选项随撤销/重做/提交自动剔除已不存在的条目 */
  const checkedPendings = useComputed$(() => {
    const ids = new Set(checkedPendingIds.value);
    return state.pendingMerges.filter((item) => ids.has(item.id));
  });
  const pendingReadyCount = useComputed$(() => state.pendingMerges.filter((item) => isReady(item)).length);
  const editingMatch = useComputed$(() => state.matches.find((match) => match.id === editingMatchId.value));
  const draftUndecided = useComputed$(() => FIELD_KEYS.filter((field) => draft[field] === ''));

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    if (match.status === 'pending') {
      notify('该匹配已暂存到待定队列，请先在队列中移出或提交后再复核');
      return;
    }
    capture();
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    const locked = ids.filter((id) => state.matches.find((match) => match.id === id)?.status === 'pending');
    if (locked.length) {
      notify(`有 ${locked.length} 条已在待定合并队列中，暂存配对不能批量复核，请先移出队列`);
      return;
    }
    capture();
    ids.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = new Date().toISOString();
    });
    commit('批量复核', `${ids.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}`, ids.flatMap((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? [match.leftId, match.rightId] : [];
    }));
    selectedMatchIds.value = [];
    notify(`已批量处理 ${ids.length} 条匹配`);
  });

  /** 打开合并弹窗：不改动任何原记录，只在草稿中暂存九个字段的来源选择。入参可为匹配 id 或待定条目 id。 */
  const openMerge = $((targetId?: string) => {
    const pendingTarget = targetId ? state.pendingMerges.find((item) => item.id === targetId) : undefined;
    const match = pendingTarget
      ? state.matches.find((item) => item.id === pendingTarget.matchId)
      : state.matches.find((item) => item.id === (targetId ?? activeMatch.value?.id));
    if (!match) return;
    if (match.status === 'merged' || match.status === 'rejected') {
      notify('该匹配已结束（已合并或已忽略），不能再暂存');
      return;
    }
    const existing = state.pendingMerges.find((item) => item.matchId === match.id);
    if (existing) {
      editingPendingId.value = existing.id;
      editingMatchId.value = match.id;
      FIELD_KEYS.forEach((field) => { draft[field] = existing.sources[field]; });
      mergeOpen.value = true;
      return;
    }
    // 同一条记录不能同时进入两个配对：命中占用时指出与哪条配对冲突并拦住
    const clash = findQueueClash(state.pendingMerges, match.leftId, match.rightId);
    if (clash) {
      const shared = clash.leftId === match.leftId || clash.rightId === match.leftId ? match.leftId : match.rightId;
      notify(`「${recordTitle(state, shared)}」已在配对「${pairLabel(state, clash.leftId, clash.rightId)}」中暂存，同一条记录不能同时进入两个配对`);
      return;
    }
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) {
      notify('配对涉及的原记录已不存在，无法暂存');
      return;
    }
    editingPendingId.value = '';
    editingMatchId.value = match.id;
    Object.assign(draft, defaultPendingSources(left, right));
    mergeOpen.value = true;
  });

  /** 保存草稿到待定队列（新增或更新），此时原记录完全不变。 */
  const savePending = $(() => {
    const match = editingMatch.value;
    if (!match) { notify('匹配已不存在，无法暂存'); return; }
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) { notify('配对涉及的原记录已不存在，无法暂存'); return; }
    const existing = state.pendingMerges.find((item) => item.id === editingPendingId.value);
    if (!existing) {
      const clash = findQueueClash(state.pendingMerges, match.leftId, match.rightId);
      if (clash) {
        const shared = clash.leftId === match.leftId || clash.rightId === match.leftId ? match.leftId : match.rightId;
        notify(`「${recordTitle(state, shared)}」已在配对「${pairLabel(state, clash.leftId, clash.rightId)}」中暂存，同一条记录不能同时进入两个配对`);
        return;
      }
      capture();
      const pending: PendingMerge = {
        id: crypto.randomUUID(),
        matchId: match.id,
        leftId: match.leftId,
        rightId: match.rightId,
        sources: { ...draft },
        fromStatus: match.status,
        addedAt: new Date().toISOString()
      };
      state.pendingMerges.unshift(pending);
      match.status = 'pending';
      commit('暂存待定合并', `${pairLabel(state, pending.leftId, pending.rightId)} 进入待定队列，${undecidedFields(pending).length} 个冲突字段待决定`, [pending.leftId, pending.rightId]);
      notify(`已暂存到待定队列（${undecidedFields(pending).length} 个字段待决定），原记录未改动`);
    } else {
      capture();
      existing.sources = { ...draft };
      existing.addedAt = new Date().toISOString();
      const remaining = undecidedFields(existing).length;
      commit('更新待定字段来源', `${pairLabel(state, existing.leftId, existing.rightId)} 的字段选择已更新，${remaining} 个冲突字段待决定`, [existing.leftId, existing.rightId]);
      notify(remaining ? `已更新暂存选择，还有 ${remaining} 个字段待决定` : '已更新暂存选择，九个字段来源均已决定');
    }
    mergeOpen.value = false;
  });

  const removePending = $((id: string) => {
    const pending = state.pendingMerges.find((item) => item.id === id);
    if (!pending) return;
    capture();
    state.pendingMerges = state.pendingMerges.filter((item) => item.id !== id);
    const match = state.matches.find((item) => item.id === pending.matchId);
    if (match && match.status === 'pending') match.status = pending.fromStatus;
    checkedPendingIds.value = checkedPendingIds.value.filter((value) => value !== id);
    commit('移出待定队列', `${pairLabel(state, pending.leftId, pending.rightId)} 已移出，配对恢复为${statusLabel(pending.fromStatus)}`, [pending.leftId, pending.rightId]);
    if (editingPendingId.value === id) { editingPendingId.value = ''; mergeOpen.value = false; }
    notify('已移出待定队列，原记录未发生变化');
  });

  const togglePendingCheck = $((id: string, checked: boolean) => {
    checkedPendingIds.value = checked
      ? [...checkedPendingIds.value, id]
      : checkedPendingIds.value.filter((value) => value !== id);
  });

  /** 勾选多条决定后一次提交：任一缺选择或被占用，整批都不生效。 */
  const submitPendings = $(() => {
    const items = checkedPendings.value;
    if (!items.length) { notify('请先勾选要提交的待定配对'); return; }
    // 1) 队列内字段未决 / 原记录缺失 / 同批内部互相占用
    const error = validateBatch(items, state.records);
    if (error) {
      const pair = pairLabel(state, error.pending.leftId, error.pending.rightId);
      if (error.kind === 'missing') notify(`整批未生效：「${pair}」还有 ${error.fields.length} 个字段未选来源（${error.fields.map(fieldLabel).join('、')}）`);
      else if (error.kind === 'missing-record') notify(`整批未生效：「${pair}」的原记录 ${error.recordId} 已不存在，请先移出队列`);
      else notify(`整批未生效：「${pair}」中的 ${recordTitle(state, error.recordId)} 与同批另一条配对「${pairLabel(state, error.by.leftId, error.by.rightId)}」占用同一条记录`);
      return;
    }
    // 2) 已被其他（未勾选的）暂存或已合并结果占用
    for (const pending of items) {
      for (const recordId of [pending.leftId, pending.rightId]) {
        const holder = state.pendingMerges.find((other) =>
          !items.some((item) => item.id === other.id) && (other.leftId === recordId || other.rightId === recordId));
        if (holder) {
          notify(`整批未生效：「${pairLabel(state, pending.leftId, pending.rightId)}」中的 ${recordTitle(state, recordId)} 仍被待定配对「${pairLabel(state, holder.leftId, holder.rightId)}」占用`);
          return;
        }
        const record = recordById(state, recordId);
        if (!record) {
          notify(`整批未生效：原记录 ${recordId} 已不存在`);
          return;
        }
      }
    }
    capture();
    const submittedCount = items.length;
    // 任何变更前固化全部原记录引用，保证多组一次提交互不串改
    const plans = items.map((pending) => ({
      pending,
      left: recordById(state, pending.leftId)!,
      right: recordById(state, pending.rightId)!,
      sources: pending.sources as Record<FieldKey, 'A' | 'B' | 'combine'>
    })).map((plan) => {
      const mergedAt = new Date().toISOString();
      const values = buildMergedValues(plan.left, plan.right, plan.sources);
      const merged = buildMergedRecord(plan.left, values, mergedAt);
      merged.id = crypto.randomUUID();
      return { ...plan, values, merged, mergedAt, mergeId: crypto.randomUUID() };
    });
    const removedIds = new Set<string>();
    plans.forEach(({ pending, left, right, sources, values, merged, mergedAt, mergeId }) => {
      state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
      state.matches.forEach((match) => {
        if (match.id === pending.matchId) { match.status = 'merged'; match.reviewedAt = mergedAt; }
        else if (match.leftId === left.id || match.rightId === right.id || match.leftId === right.id || match.rightId === left.id) match.status = 'rejected';
      });
      state.merges.unshift({ id: mergeId, matchId: pending.matchId, leftId: left.id, rightId: right.id, chosen: { ...sources }, values, mergedAt });
      const aCount = FIELD_KEYS.filter((field) => sources[field] === 'A').length;
      const bCount = FIELD_KEYS.filter((field) => sources[field] === 'B').length;
      const combineCount = FIELD_KEYS.filter((field) => sources[field] === 'combine').length;
      commit('合并两条记录', `${pairLabel(state, pending.leftId, pending.rightId)}：保留 ${aCount} 个 A 来源字段、${bCount} 个 B 来源字段、${combineCount} 个拼接字段`, [pending.leftId, pending.rightId, merged.id]);
      removedIds.add(pending.id);
    });
    state.pendingMerges = state.pendingMerges.filter((item) => !removedIds.has(item.id));
    commit('批量提交待定合并', `一次提交 ${submittedCount} 组待定配对，原记录、合并结果与字段来源均已写入审计`, items.flatMap((item) => [item.leftId, item.rightId]));
    checkedPendingIds.value = [];
    editingPendingId.value = '';
    notify(`已一次提交 ${submittedCount} 组配对，合并结果与字段来源已进入审计`);
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed'
      };
      state.records.push(record);
    });
    state.matches = computeMatches(state.records);
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      records: state.records,
      matches: state.matches,
      pendingMerges: state.pendingMerges,
      merges: state.merges,
      audit: state.audit
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('sologsb-1020-archive-state-v1');
      if (raw) restore(raw);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => snapshot());
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      // 弹窗打开时只处理快捷键级动作，避免 J/K/Enter 误改背后的核对队列
      if (mergeOpen.value || importOpen.value) return;
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 3; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  const allChecked = state.pendingMerges.length > 0 && checkedPendings.value.length === state.pendingMerges.length;

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>合并先进入待定队列暂存九个字段来源，批量决定后一次提交，任何缺选或占用都会让整批原封不动。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="warning"><strong>{state.pendingMerges.length}</strong><span>待定合并{state.pendingMerges.length ? ` · ${pendingReadyCount.value} 组已决` : ''}</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 暂存</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="pending">待合并</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{statusLabel(match.status)}</span>
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => {
              const pending = state.pendingMerges.find((item) => item.leftId === record.id || item.rightId === record.id);
              return (
                <div class="table-row" key={record.id}>
                  <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                  <strong>{record.title}</strong>
                  <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                  <code>{record.identifier}</code>
                  <span class={`record-status ${pending ? 'pending' : record.status}`}>{pending ? '待合并' : record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
                </div>
              );
            })}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>待定队列</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const left = recordById(state, activeMatch.value!.leftId)!;
                const right = recordById(state, activeMatch.value!.rightId)!;
                const staged = state.pendingMerges.find((item) => item.matchId === activeMatch.value!.id);
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  {staged && <div class="staged-hint">已暂存到待定队列：{undecidedFields(staged).length ? `${undecidedFields(staged).map(fieldLabel).join('、')} 待决定` : '九个字段来源均已决定，等待勾选提交'}</div>}
                  <div class="action-stack"><button class="button primary wide" onClick$={() => openMerge(activeMatch.value!.id)}>{staged ? '编辑暂存字段来源' : '暂存到待定队列'}</button><div class="split-actions"><button class="button confirm" onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              <div class="queue-summary">
                <strong>{state.pendingMerges.length}</strong><span>组待定 · {pendingReadyCount.value} 组已决 · 已勾选 {checkedPendings.value.length} 组</span>
                <button class="button small ghost" onClick$={() => panelTab.value = 1}>在下方队列操作</button>
              </div>
              {state.pendingMerges.length ? state.pendingMerges.map((pending) => {
                const left = recordById(state, pending.leftId);
                const undecided = undecidedFields(pending);
                return <div class="queue-mini" key={pending.id}>
                  <strong>{left?.title ?? pending.leftId} ↔ {recordTitle(state, pending.rightId)}</strong>
                  <span class={undecided.length ? 'queue-conflict' : 'queue-ok'}>{undecided.length ? `${undecided.map(fieldLabel).join('、')} 待决定` : '九个字段已全部决定'}</span>
                </div>;
              }) : <div class="empty-state">待定队列为空。在匹配卡片按 Enter 或点击“暂存到待定队列”，原记录不会被立即改动。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabel(field as FieldKey)}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。待定队列一次提交后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开字段来源选择并暂存到待定队列（不改原记录）</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配（暂存中的配对会被拦住）</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做，待定队列与勾选随之恢复</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="pending-band">
        <div class="panel pending-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">03 / PENDING MERGE QUEUE</span><h3>待定合并队列</h3></div>
            <span class="shortcut-hint">每组暂存九个字段来源 · 涉及 {claimedIds.value.size} 条记录 · {state.pendingMerges.length - pendingReadyCount.value} 组有未决冲突</span>
          </div>
          <div class="toolbar-row queue-toolbar">
            <label class="queue-checkall"><input type="checkbox" checked={allChecked} onChange$={(event) => { checkedPendingIds.value = (event.target as HTMLInputElement).checked ? state.pendingMerges.map((item) => item.id) : []; }} /><span>全选</span></label>
            <button class="button small primary" disabled={!checkedPendings.value.length} onClick$={submitPendings}>一次提交勾选的 {checkedPendings.value.length || ''} 组</button>
            <span class="queue-rule">任一配对缺字段选择或记录被其他提交占用，整批都不会生效</span>
          </div>
          <div class="queue-list">
            {state.pendingMerges.map((pending) => {
              const left = recordById(state, pending.leftId);
              const right = recordById(state, pending.rightId);
              const undecided = undecidedFields(pending);
              const ready = undecided.length === 0;
              const checked = checkedPendingIds.value.includes(pending.id);
              return (
                <article class={`queue-row ${checked ? 'checked' : ''}`} key={pending.id}>
                  <label class="queue-select"><input type="checkbox" checked={checked} onChange$={(event) => togglePendingCheck(pending.id, (event.target as HTMLInputElement).checked)} /></label>
                  <div class="queue-pair">
                    <strong>{left?.title ?? pending.leftId} <i>↔</i> {right?.title ?? pending.rightId}</strong>
                    <span><code>{left?.identifier ?? pending.leftId}</code> · <code>{right?.identifier ?? pending.rightId}</code> · 暂存于 {new Date(pending.addedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div class={`queue-conflicts ${ready ? 'ok' : ''}`}>
                    {ready ? <em>九字段来源已齐</em> : <>
                      <em>{undecided.length} 个未决冲突</em>
                      <span class="conflict-chips">{undecided.map((field) => <b key={field}>{fieldLabel(field)}</b>)}</span>
                    </>}
                  </div>
                  <div class="queue-state">
                    {FIELD_KEYS.map((field) => <i key={field} class={`chip ${pending.sources[field] === '' ? 'undecided' : (pending.sources[field] === 'combine' ? 'combine' : pending.sources[field]?.toLowerCase())}`} title={fieldLabel(field)}>{fieldLabel(field)}·{pending.sources[field] === '' ? '?' : pending.sources[field] === 'combine' ? '拼' : pending.sources[field]}</i>)}
                  </div>
                  <div class="queue-actions">
                    <button class="button small" onClick$={() => openMerge(pending.id)}>编辑选择</button>
                    <button class="button small danger-ghost" onClick$={() => removePending(pending.id)}>移出</button>
                  </div>
                </article>
              );
            })}
            {!state.pendingMerges.length && <div class="empty-state">待定队列为空。从匹配核对队列选择配对并按 Enter，逐字段暂存 A / B / 拼接来源；原记录只在批量提交成功后才会变化。</div>}
          </div>
        </div>
      </section>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">04 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，但系统不会替研究者自动决定。</p>
          <div class="rule-row"><span>1</span><p>打开字段合并只暂存九个字段的 A / B / 拼接来源，原记录在正式提交前保持不变。</p></div>
          <div class="rule-row"><span>2</span><p>同一条记录不能同时进入两个配对；重复暂存会指出冲突配对并拦住。</p></div>
          <div class="rule-row"><span>3</span><p>勾选多组一次提交：有缺选择或记录被占用时整批不生效；成功后原记录、合并结果、字段来源全部进入审计。</p></div>
          <div class="rule-row"><span>4</span><p>撤销重做与本地离线保存随待定队列一起恢复，刷新页面不丢暂存。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE · PENDING</span><Modal.Title>{editingPendingId.value ? '编辑待定字段来源' : '暂存字段保留来源'}</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {editingMatch.value && (() => {
            const match = editingMatch.value!;
            const left = recordById(state, match.leftId)!;
            const right = recordById(state, match.rightId)!;
            return <>
              <Modal.Description class="modal-description">
                这里只暂存九个字段的来源选择，<strong>不会改动任何原记录</strong>。保存后配对进入待定队列；{draftUndecided.value.length ? `还有 ${draftUndecided.value.map(fieldLabel).join('、')} ${draftUndecided.value.length} 个冲突字段未决定，未决定时无法批量提交` : '九个字段均已决定，可在队列中勾选后一次提交'}。
              </Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span><span></span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  const picked = draft[field] !== '';
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'} ${!picked ? 'undecided-row' : ''}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : picked ? <small>已决定</small> : <small class="todo">待选择</small>}</div><label class={`source-option ${draft[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={draft[field] === 'A'} onChange$={() => draft[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${draft[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={draft[field] === 'B'} onChange$={() => draft[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${draft[field] === 'combine' ? 'selected' : ''}`} onClick$={() => draft[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer">
                {editingPendingId.value && <button class="button danger-ghost" style="margin-right:auto" onClick$={() => removePending(editingPendingId.value)}>移出待定队列</button>}
                <Modal.Close class="button ghost">取消（不保存草稿）</Modal.Close>
                <button class="button primary" onClick$={savePending}>保存到待定队列{draftUndecided.value.length ? `（${draftUndecided.value.length} 项待决定）` : '（九项已决定）'}</button>
              </Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
