import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, FieldChoice, FieldKey, MatchCandidate, RecordGroup
} from './types';
import {
  FIELD_KEYS, buildMergedRecord, computeMatches, fieldValue,
  findInternalOverlap, findQueueOccupant, unresolvedFields
} from './utils/matching';
import { seedState } from './data/seed';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const selectedPendingIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  /** 暂存窗口正在编辑的待定项 id；为空表示从匹配卡片新增 */
  const editingPendingId = useSignal<string | null>(null);
  const editingLeftId = useSignal('');
  const editingRightId = useSignal('');
  const editingMatchId = useSignal('');
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    pending: state.pending,
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
    state.merges = next.merges ?? state.merges;
    state.pending = next.pending ?? [];
    state.audit = next.audit ?? state.audit;
    // 选中集合不能指向已被撤销/重做改变的队列项
    const pendingIds = new Set(state.pending.map((item) => item.id));
    selectedPendingIds.value = selectedPendingIds.value.filter((id) => pendingIds.has(id));
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 2800);
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
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
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

  const pendingByMatch = useComputed$(() => {
    const map = new Map<string, typeof state.pending[number]>();
    state.pending.forEach((item) => { map.set(item.matchId, item); });
    return map;
  });
  const unresolvedCount = useComputed$(() => state.pending.reduce(
    (total, item) => total + unresolvedFields(item.choices).length, 0
  ));
  const readyPendingIds = useComputed$(() => new Set(
    state.pending.filter((item) => unresolvedFields(item.choices).length === 0).map((item) => item.id)
  ));

  const editingLeft = useComputed$(() => recordById(state, editingLeftId.value));
  const editingRight = useComputed$(() => recordById(state, editingRightId.value));
  const editingPending = useComputed$(() => state.pending.find((item) => item.id === editingPendingId.value) ?? null);

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    capture();
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
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

  // 暂存窗口中九个字段的来源选择；冲突字段默认为 undefined（待定）
  const choices = useStore<Record<FieldKey, FieldChoice | undefined>>({
    title: undefined, date: undefined, people: undefined, places: undefined, identifier: undefined,
    medium: undefined, extent: undefined, rights: undefined, notes: undefined
  });

  const resetChoices = (left: ArchiveRecord, right: ArchiveRecord, saved?: Partial<Record<FieldKey, FieldChoice>>) => {
    FIELD_KEYS.forEach((field) => {
      if (saved?.[field]) choices[field] = saved[field];
      // 两侧一致时不需要选择，统一以 A 来源占位
      else choices[field] = fieldValue(left, field) === fieldValue(right, field) ? 'A' : undefined;
    });
  };

  const openMerge = $((matchId?: string, leftId?: string, rightId?: string) => {
    const match = matchId
      ? state.matches.find((item) => item.id === matchId)
      : activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right || left.status === 'merged' || right.status === 'merged') {
      notify('记录已被合并，无法再暂存这一配对');
      return;
    }
    const existing = state.pending.find((item) => item.matchId === match.id);
    state.activeMatchId = match.id;
    editingPendingId.value = existing?.id ?? null;
    editingLeftId.value = leftId ?? match.leftId;
    editingRightId.value = rightId ?? match.rightId;
    editingMatchId.value = match.id;
    resetChoices(left, right, existing?.choices);
    mergeOpen.value = true;
  });

  // 把当前字段来源选择暂存进待定队列，原记录一条都不改
  const stagePending = $(() => {
    const left = recordById(state, editingLeftId.value);
    const right = recordById(state, editingRightId.value);
    const match = state.matches.find((item) => item.id === editingMatchId.value);
    if (!left || !right || !match) return;
    const occupant = findQueueOccupant(state.pending, left.id, right.id, editingPendingId.value ?? undefined);
    if (occupant) {
      const other = recordById(state, occupant.sharedRecordId);
      notify(`与待定队列第 ${state.pending.indexOf(occupant.pending) + 1} 组冲突：记录「${other?.title ?? occupant.sharedRecordId}」已在另一配对中，先移出或提交那一组`);
      return;
    }
    // 两侧一致字段自动记 A，只让真正冲突的字段保持未决
    const saved: Partial<Record<FieldKey, FieldChoice>> = {};
    FIELD_KEYS.forEach((field) => {
      const choice = choices[field];
      saved[field] = choice ?? (fieldValue(left, field) === fieldValue(right, field) ? 'A' : undefined);
    });
    const missing = unresolvedFields(saved);
    capture();
    const now = new Date().toISOString();
    if (editingPendingId.value) {
      const pending = state.pending.find((item) => item.id === editingPendingId.value);
      if (pending) pending.choices = saved;
      commit('更新待定合并', `调整「${matchLabel(state, match)}」的字段来源，仍有 ${missing.length} 个未决冲突`, [left.id, right.id]);
      notify(missing.length ? `已保存暂存，还有 ${missing.length} 个未决冲突` : '已保存暂存，九个字段均已选定');
    } else {
      const pending = {
        id: crypto.randomUUID(),
        matchId: match.id,
        leftId: left.id,
        rightId: right.id,
        score: match.score,
        reasons: match.reasons,
        choices: saved,
        stagedAt: now
      };
      state.pending.unshift(pending);
      selectedPendingIds.value = [...selectedPendingIds.value, pending.id];
      commit('加入待定队列', `暂存「${matchLabel(state, match)}」的九字段来源，${missing.length} 个冲突待决定`, [left.id, right.id]);
      notify(missing.length ? `已加入待定队列，${missing.length} 个冲突字段尚未选择` : '已加入待定队列，九个字段均已选定');
    }
    mergeOpen.value = false;
    panelTab.value = 1;
  });

  const removePending = $((pendingId: string) => {
    const pending = state.pending.find((item) => item.id === pendingId);
    if (!pending) return;
    capture();
    state.pending = state.pending.filter((item) => item.id !== pendingId);
    selectedPendingIds.value = selectedPendingIds.value.filter((id) => id !== pendingId);
    if (editingPendingId.value === pendingId) mergeOpen.value = false;
    commit('移出待定队列', `取消暂存「${recordById(state, pending.leftId)?.title ?? pending.leftId} ↔ ${recordById(state, pending.rightId)?.title ?? pending.rightId}」`, [pending.leftId, pending.rightId]);
    notify('已移出待定队列，原记录未受影响');
  });

  const pendingLabel = (pending: { leftId: string; rightId: string }) =>
    `${recordById(state, pending.leftId)?.title ?? pending.leftId} ↔ ${recordById(state, pending.rightId)?.title ?? pending.rightId}`;

  // 勾选多条待定项后一次提交；任何一条缺选择或记录被占用，整批都不生效
  const submitPending = $(() => {
    const ids = selectedPendingIds.value;
    if (!ids.length) {
      notify('请先勾选要提交的待定项');
      return;
    }
    const picked = ids
      .map((id) => state.pending.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (picked.length !== ids.length) {
      notify('所选待定项已被其他提交占用或已移除，整批未生效');
      return;
    }
    for (const pending of picked) {
      const left = recordById(state, pending.leftId);
      const right = recordById(state, pending.rightId);
      if (!left || !right || left.status === 'merged' || right.status === 'merged') {
        notify(`「${pendingLabel(pending)}」涉及的记录已被合并占用，整批未生效`);
        return;
      }
    }
    // 队列内同一记录出现在两组配对中也算互相占用
    const overlap = findInternalOverlap(picked);
    if (overlap) {
      const record = recordById(state, overlap.sharedRecordId);
      notify(`「${overlap.first.matchId}」与「${overlap.second.matchId}」都要占用记录「${record?.title ?? overlap.sharedRecordId}」，整批未生效`);
      return;
    }
    // 未勾选的待定项同样占着记录：新提交不能撞它们
    for (const pending of picked) {
      const blocker = findQueueOccupant(
        state.pending.filter((item) => !ids.includes(item.id)),
        pending.leftId,
        pending.rightId
      );
      if (blocker) {
        const record = recordById(state, blocker.sharedRecordId);
        notify(`「${pendingLabel(pending)}」与待定队列中未提交的一组都要使用「${record?.title ?? blocker.sharedRecordId}」，整批未生效`);
        return;
      }
      const missing = unresolvedFields(pending.choices);
      if (missing.length) {
        notify(`「${pendingLabel(pending)}」还有 ${missing.length} 个字段未选择来源，整批未生效`);
        return;
      }
    }
    capture();
    const mergedIds: string[] = [];
    const removedIds: string[] = picked.map((item) => item.id);
    const consumedRecordIds = new Set<string>();
    const newRecords: ArchiveRecord[] = [];
    const timestamp = new Date().toISOString();
    // 所有原记录与合并结果都先算好，最后一次性替换，避免循环中途找不到下一对的原记录
    picked.forEach((pending) => {
      const left = recordById(state, pending.leftId)!;
      const right = recordById(state, pending.rightId)!;
      const { record: merged, values } = buildMergedRecord(left, right, pending.choices, timestamp);
      consumedRecordIds.add(left.id);
      consumedRecordIds.add(right.id);
      newRecords.push(merged);
      state.matches.forEach((item) => {
        if (item.id === pending.matchId) item.status = 'merged';
        else if ([item.leftId, item.rightId].includes(left.id) || [item.leftId, item.rightId].includes(right.id)) item.status = 'rejected';
      });
      state.merges.unshift({
        id: crypto.randomUUID(),
        matchId: pending.matchId,
        pendingId: pending.id,
        leftId: left.id,
        rightId: right.id,
        mergedId: merged.id,
        chosen: { ...pending.choices },
        values,
        mergedAt: timestamp
      });
      mergedIds.push(left.id, right.id, merged.id);
      commit('待定队列合并', `经待定队列提交「${pendingLabel(pending)}」，原记录、合并结果与字段来源已入审计`, [left.id, right.id, merged.id]);
    });
    state.records = [...state.records.filter((record) => !consumedRecordIds.has(record.id)), ...newRecords];
    state.pending = state.pending.filter((item) => !removedIds.includes(item.id));
    selectedPendingIds.value = [];
    if (picked.length > 1) {
      commit('批量提交待定合并', `${picked.length} 组配对一次提交，全部通过缺选与占用校验`, mergedIds);
    }
    notify(`已提交 ${picked.length} 组待定合并，原记录、合并结果与字段来源已写入审计`);
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
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records, matches: state.matches, merges: state.merges, pending: state.pending, audit: state.audit }, null, 2)], { type: 'application/json' });
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
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ArchiveState>;
        restore(JSON.stringify(saved));
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({
      revision: state.revision,
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      pending: state.pending,
      audit: state.audit
    }));
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
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'q') { event.preventDefault(); panelTab.value = 1; }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

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
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>逐条确认可疑匹配，保留每个字段的来源选择，并留下可追溯的处理记录。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div><strong>{state.pending.length}</strong><span>待定队列 · {unresolvedCount.value} 个未决</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 暂存待定</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              const queued = pendingByMatch.value.get(match.id);
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
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
                    {queued && <span class={`queued-tag ${unresolvedFields(queued.choices).length ? 'pending' : 'ready'}`}>待定{unresolvedFields(queued.choices).length ? ` · ${unresolvedFields(queued.choices).length} 未决` : ' · 齐'}</span>}
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
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list">
              <Tabs.Tab>复核详情</Tabs.Tab>
              <Tabs.Tab>待定队列{state.pending.length ? ` (${state.pending.length})` : ''}</Tabs.Tab>
              <Tabs.Tab>合并追溯</Tabs.Tab>
              <Tabs.Tab>键盘帮助</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const left = recordById(state, activeMatch.value!.leftId);
                const right = recordById(state, activeMatch.value!.rightId);
                if (!left || !right) return <div class="empty-state">这组配对涉及的记录已被合并，详情请在合并追溯中查看。</div>;
                const queued = pendingByMatch.value.get(activeMatch.value!.id);
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}{fieldValue(left, field) !== fieldValue(right, field) ? <em class="conflict-flag">冲突</em> : null}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  {queued && <div class={`queue-banner ${unresolvedFields(queued.choices).length ? 'pending' : 'ready'}`}>已在待定队列中：{unresolvedFields(queued.choices).length ? `${unresolvedFields(queued.choices).length} 个冲突字段尚未决定` : '九个字段来源均已选定，可去队列提交'}</div>}
                  <div class="action-stack"><button class="button primary wide" onClick$={() => openMerge(activeMatch.value!.id)}>{queued ? '编辑待定字段选择' : '暂存到待定队列'}</button><div class="split-actions"><button class="button confirm" onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel queue-panel">
              <div class="queue-toolbar">
                <input
                  type="checkbox"
                  class="native-check"
                  aria-label="全选已定待定项"
                  checked={state.pending.length > 0 && readyPendingIds.value.size > 0 && selectedPendingIds.value.length === readyPendingIds.value.size}
                  onChange$={(event) => {
                    selectedPendingIds.value = (event.target as HTMLInputElement).checked ? [...readyPendingIds.value] : [];
                  }}
                />
                <span>选择已定项 · 勾 {selectedPendingIds.value.length} / {state.pending.length}</span>
                <button class="button small primary" disabled={!selectedPendingIds.value.length} onClick$={submitPending}>一次提交勾选</button>
              </div>
              {!state.pending.length && <div class="empty-state">待定队列为空。在匹配卡片上暂存九字段来源后，会先到这里等待，原记录不会立即被改。</div>}
              {state.pending.map((pending, index) => {
                const left = recordById(state, pending.leftId);
                const right = recordById(state, pending.rightId);
                const missing = unresolvedFields(pending.choices);
                const checked = selectedPendingIds.value.includes(pending.id);
                return (
                  <article class={`queue-card ${missing.length ? 'is-pending' : 'is-ready'}`} key={pending.id}>
                    <div class="queue-card-head">
                      <input
                        type="checkbox"
                        class="native-check"
                        aria-label={`选择待定项 ${pending.matchId}`}
                        checked={checked}
                        onChange$={(event) => {
                          const value = (event.target as HTMLInputElement).checked;
                          selectedPendingIds.value = value
                            ? [...selectedPendingIds.value, pending.id]
                            : selectedPendingIds.value.filter((id) => id !== pending.id);
                        }}
                      />
                      <span class="queue-index">#{index + 1}</span>
                      <span class="queue-tag">{missing.length ? `未决 ${missing.length}` : '九个字段已齐'}</span>
                      <span class="queue-score">{Math.round(pending.score * 100)}%</span>
                    </div>
                    <div class="queue-pairs">
                      <div><small>A · {left?.identifier ?? pending.leftId}</small><strong>{left?.title ?? '记录已不存在'}</strong></div>
                      <i>↔</i>
                      <div><small>B · {right?.identifier ?? pending.rightId}</small><strong>{right?.title ?? '记录已不存在'}</strong></div>
                    </div>
                    <div class="queue-fields">
                      {fieldLabels.map(([field, label]) => {
                        const choice = pending.choices[field];
                        return <span class={`queue-chip ${choice ? `src-${choice === 'combine' ? 'mix' : choice.toLowerCase()}` : 'undecided'}`} key={field} title={`${label}：${choice ? (choice === 'combine' ? '双来源拼接' : `${choice} 来源`) : '未选择来源'}`}>{label}{choice ? ` ${choice === 'combine' ? '拼' : choice}` : ' ？'}</span>;
                      })}
                    </div>
                    {missing.length > 0 && <p class="queue-missing">未决冲突：{missing.map((field) => fieldLabels.find(([key]) => key === field)?.[1]).join('、')}</p>}
                    <div class="queue-actions">
                      <button class="button small ghost" onClick$={() => openMerge(pending.matchId, pending.leftId, pending.rightId)}>{missing.length ? '补选字段' : '查看 / 修改'}</button>
                      <button class="button small danger" onClick$={() => removePending(pending.id)}>移出队列</button>
                    </div>
                  </article>
                );
              })}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                const merged = recordById(state, merge.mergedId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')} · {merge.pendingId ? '经待定队列提交' : '直接合并'}{merged ? ` · 合并结果：${merged.title}（${merged.identifier}）` : ''}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。待定项正式提交后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>把当前匹配暂存进待定队列</span></div><div><kbd>Q</kbd><span>切到待定队列</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做（含待定队列）</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，但系统不会替研究者自动决定。</p>
          <div class="rule-row"><span>1</span><p>字段选择先暂存进待定队列，冲突字段可留空未决；同一条记录不能同时进入两组配对。</p></div>
          <div class="rule-row"><span>2</span><p>勾选多项一次提交：有一条缺选择或记录被占用，整批都不生效。</p></div>
          <div class="rule-row"><span>3</span><p>原记录、合并结果和九字段来源都进审计；撤销重做与本地保存随待定队列一起恢复。</p></div>
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
          <Modal.Header class="modal-header"><div><span class="eyebrow">PENDING STAGING</span><Modal.Title>暂存九字段保留来源{editingPending.value ? ' · 编辑待定项' : ''}</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {editingLeft.value && editingRight.value && (() => {
            const left = editingLeft.value!;
            const right = editingRight.value!;
            const missing = unresolvedFields({ ...choices });
            return <>
              <Modal.Description class="modal-description">这里只暂存选择，不会改动原记录。一致字段自动记为 A 来源；冲突字段可暂缓决定，随后在待定队列补选。{missing.length ? `当前还有 ${missing.length} 个未决冲突：${missing.map((field) => fieldLabels.find(([key]) => key === field)?.[1]).join('、')}` : '九个字段均已选定，提交前仍可继续调整。'}</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span><span>操作</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${choices[field] ? '' : 'undecided'} ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致 · 记 A</small> : choices[field] ? <small class="decided">已选 {choices[field] === 'combine' ? '拼接' : choices[field]}</small> : <small>未决冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><div class="picker-actions"><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button>{!same && <button class="defer-button" title="先不决定，留到待定队列补选" onClick$={() => choices[field] = undefined}>待定</button>}</div></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={stagePending}>{missing.length ? `暂存，留 ${missing.length} 个未决` : '暂存九个字段选择'}</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
