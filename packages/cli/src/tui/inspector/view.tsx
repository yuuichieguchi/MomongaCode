import { Box, Text } from 'ink';
import { escapeTerminalLine, INSPECTOR_TABS } from '@momonga/protocol';
import type { InspectorDiagnostic, InspectorSnapshot, InspectorTab } from '@momonga/protocol';
import { shownKey } from '../keys/table.ts';
import type { KeyTable } from '../keys/table.ts';
import { borderOf, styleOf } from '../screen/theme.ts';
import {
  INSPECTOR_TAB_TITLES,
  badgeForCondition,
  badgeForSeverity,
  badgeForToolStatus,
  formatDuration,
  formatPercent,
  formatTimestamp,
  formatTokens,
  formatUsd,
  renderProgressBar,
  renderSparkline,
  renderStackedBar,
  truncateText,
  visibleWindow,
} from './format.ts';
import { filteredSortedContextItems, resolveSelectedIndex } from './state.ts';
import type { InspectorUiState } from './state.ts';

export type InspectorViewProps = {
  readonly snapshot: InspectorSnapshot;
  readonly ui: InspectorUiState;
  readonly keys: KeyTable;
  readonly columns: number;
  readonly rows: number;
  readonly fullscreen: boolean;
};

const diagnosticStyle = (severity: InspectorDiagnostic['severity']) => {
  if (severity === 'critical' || severity === 'warning') return styleOf([severity === 'critical' ? 'error' : 'warning']);
  return styleOf(['notice']);
};

const hintSegment = (keys: KeyTable, action: Parameters<KeyTable['keyHint']>[0], fallbackLabel: string): string => {
  const hint = keys.keyHint(action);
  return hint === '' ? '' : `[${hint}] ${fallbackLabel}`;
};

const tabNavSegment = (keys: KeyTable): string => {
  const next = keys.keysFor('inspector.tabNext').map(shownKey);
  const prev = keys.keysFor('inspector.tabPrev').map(shownKey);
  const parts = [next[0], prev[1], next[1]].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : `[${parts.join('/')}] Tab`;
};

export const inspectorFooterHints = (keys: KeyTable, ui: InspectorUiState): string => {
  const base = [
    tabNavSegment(keys),
    hintSegment(keys, 'inspector.up', 'Move'),
    hintSegment(keys, 'inspector.subView', 'Section'),
  ];
  if (ui.detail !== null) {
    return [
      hintSegment(keys, 'inspector.back', 'Back'),
      hintSegment(keys, 'inspector.close', 'Close'),
    ]
      .filter((part) => part !== '')
      .join('  ');
  }
  const extra: string[] = [];
  if (ui.tab === 'context') {
    extra.push(hintSegment(keys, 'inspector.openDetail', 'Detail'));
    extra.push(hintSegment(keys, 'inspector.sort', `Sort(${ui.contextSort})`));
    extra.push(hintSegment(keys, 'inspector.filter', `Filter(${ui.contextCategoryFilter})`));
    extra.push(hintSegment(keys, 'inspector.exclude', 'Toggle exclude'));
    extra.push(hintSegment(keys, 'inspector.compact', 'Compaction'));
  } else if (ui.tab === 'memory') {
    extra.push(hintSegment(keys, 'inspector.openDetail', 'Detail'));
    extra.push(hintSegment(keys, 'inspector.exclude', 'Exclude'));
    extra.push(hintSegment(keys, 'inspector.pin', 'Pin'));
    extra.push(hintSegment(keys, 'inspector.search', 'Search'));
    extra.push(hintSegment(keys, 'inspector.edit', 'Edit'));
    extra.push(hintSegment(keys, 'inspector.delete', 'Retire'));
  } else if (ui.tab === 'usage' || ui.tab === 'execution') {
    extra.push(hintSegment(keys, 'inspector.openDetail', 'Detail'));
    if (ui.tab === 'execution') extra.push(hintSegment(keys, 'inspector.filter', `Filter(${ui.executionFilter})`));
  }
  extra.push(hintSegment(keys, 'inspector.refresh', 'Refresh'));
  extra.push(hintSegment(keys, 'inspector.close', 'Close'));
  return [...base, ...extra].filter((part) => part !== '').join('  ');
};

export const inspectorRowIdsFor = (snapshot: InspectorSnapshot, ui: InspectorUiState): string[] => {
  switch (ui.tab) {
    case 'overview':
      return snapshot.diagnostics.map((d) => d.id);
    case 'context':
      if (ui.contextSubView === 'compactions') return snapshot.context.compactions.map((c) => c.id);
      if (ui.contextSubView === 'breakdown') return snapshot.context.categories.map((c) => c.key);
      return filteredSortedContextItems(snapshot, ui).map((item) => item.id);
    case 'memory':
      if (ui.memorySubView === 'active') return snapshot.memory.active.map((m) => m.id);
      if (ui.memorySubView === 'trace') return snapshot.memory.retrievalTrace?.candidates.map((c) => c.id) ?? [];
      if (ui.memorySubView === 'lifecycle') return snapshot.memory.lifecycle.map((e) => e.id);
      return filteredMemories(snapshot, ui).map((m) => m.id);
    case 'usage':
      if (ui.usageSubView === 'requests') return snapshot.usage.requests.map((r) => r.id);
      if (ui.usageSubView === 'cost') return snapshot.usage.cost.byModel.map((m) => `${m.provider}:${m.model}`);
      return [];
    case 'execution':
      if (ui.executionSubView === 'verification') return snapshot.execution.completionConditions.map((c) => c.id);
      if (ui.executionSubView === 'plan') return snapshot.execution.plan.map((_, i) => `plan-${i}`);
      return filteredToolCalls(snapshot, ui).map((t) => t.callId);
  }
};

const filteredMemories = (snapshot: InspectorSnapshot, ui: Pick<InspectorUiState, 'memoryFilter'>) => {
  const excludedSet = new Set(snapshot.memory.sessionControls.excludedIds);
  const pinnedSet = new Set(snapshot.memory.sessionControls.pinnedIds);
  return snapshot.memory.allMemories.filter((m) => {
    if (ui.memoryFilter === 'all') return true;
    if (ui.memoryFilter === 'pinned') return pinnedSet.has(m.id);
    if (ui.memoryFilter === 'excluded') return excludedSet.has(m.id);
    return String(m.state) === ui.memoryFilter;
  });
};

const filteredToolCalls = (snapshot: InspectorSnapshot, ui: Pick<InspectorUiState, 'executionFilter'>) =>
  snapshot.execution.toolCalls.filter((call) => {
    if (ui.executionFilter === 'all') return true;
    if (ui.executionFilter === 'failed') return call.status === 'failed' || call.status === 'denied';
    if (ui.executionFilter === 'running') return call.status === 'running' || call.status === 'requested';
    return call.status === 'awaiting_approval' || call.status === 'awaiting_input';
  });

const safe = (text: string, width: number): string => truncateText(escapeTerminalLine(text), width);

const renderDetailPanel = (snapshot: InspectorSnapshot, ui: InspectorUiState, innerWidth: number, listRows: number) => {
  const detail = ui.detail;
  if (detail === null) return null;
  const lines: string[] = [];
  if (detail.kind === 'context_item') {
    const item = snapshot.context.items.find((entry) => entry.id === detail.id);
    if (item === undefined) {
      lines.push('Context item is no longer present.');
    } else {
      lines.push(`Category : ${item.category}`);
      lines.push(`Label    : ${item.label}`);
      lines.push(`Source   : ${item.source}`);
      lines.push(`Tokens   : ${formatTokens(item.tokens)} (${formatPercent(item.share)})`);
      lines.push(`Cached   : ${item.cached}`);
      if (item.seq !== undefined) lines.push(`Seq      : ${item.seq}`);
      if (item.callId !== undefined) lines.push(`Call ID  : ${item.callId}`);
      if (item.handle !== undefined) lines.push(`Handle   : ${item.handle}`);
      if (item.sizeBytes !== undefined) lines.push(`Bytes    : ${item.sizeBytes}`);
      lines.push(`Status   : ${item.evicted ? 'Excluded / Evicted' : 'Active in context'}`);
      lines.push('');
      lines.push(`Preview  : ${item.preview}`);
    }
  } else if (detail.kind === 'compaction') {
    const entry = snapshot.context.compactions.find((c) => c.id === detail.id);
    if (entry === undefined) {
      lines.push('Compaction entry not found.');
    } else {
      lines.push(`Reason   : ${entry.reason} (source: ${entry.source})`);
      lines.push(`Seq      : ${entry.seq} (replaced through #${entry.replacedThroughSeq})`);
      lines.push(`Tokens   : ${formatTokens(entry.tokensBefore)} -> ${formatTokens(entry.tokensAfter)}${entry.tokensAfterEstimated ? ' (est)' : ''}`);
      lines.push(`Saved    : ${formatTokens(entry.savedTokens)} (${formatPercent(entry.ratio)})`);
      lines.push(`Duration : ${formatDuration(entry.durationMs)}`);
      lines.push(`Cost     : ${formatUsd(entry.costUsd)}`);
      if (entry.rejected) lines.push(`Error    : ${entry.error ?? 'Compaction rejected'}`);
      if (entry.preservedInfo.length > 0) lines.push(`Preserved: ${entry.preservedInfo.join(', ')}`);
      lines.push('');
      lines.push(`Summary  : ${entry.summaryPreview || '(none recorded)'}`);
    }
  } else if (detail.kind === 'memory') {
    const active = snapshot.memory.active.find((m) => m.id === detail.id);
    const full = snapshot.memory.allMemories.find((m) => m.id === detail.id);
    const excluded = snapshot.memory.sessionControls.excludedIds.includes(detail.id);
    const pinned = snapshot.memory.sessionControls.pinnedIds.includes(detail.id);
    if (active === undefined && full === undefined) {
      lines.push('Memory entry not found.');
    } else {
      const kind = active?.kind ?? String(full?.kind ?? '');
      const scope = active?.scope ?? String(full?.scope ?? '');
      const state = active?.state ?? String(full?.state ?? '');
      const status = active?.status ?? full?.status ?? 'unverifiable';
      const createdAt = active?.createdAt ?? full?.createdAt ?? null;
      const keptAt = active?.keptAt ?? full?.keptAt ?? null;
      const contributedAt = active?.contributedAt ?? full?.contributedAt ?? null;
      const text = active?.text ?? full?.text ?? '';
      lines.push(`ID       : ${detail.id}`);
      lines.push(`Kind/Scp : ${kind} / ${scope} (state: ${state}, status: ${status})`);
      lines.push(`Controls : ${pinned ? '[PINNED]' : 'not pinned'}, ${excluded ? '[SESSION EXCLUDED]' : 'included'}`);
      lines.push(`Created  : ${formatTimestamp(createdAt)}  Kept: ${formatTimestamp(keptAt)}  Used: ${formatTimestamp(contributedAt)}`);
      if (active !== undefined) {
        lines.push(`Adoption : ${active.adoptionReason}`);
        if (active.evidence.files.length > 0) lines.push(`Files    : ${active.evidence.files.join(', ')}`);
        if (active.evidence.commit !== undefined) lines.push(`Commit   : ${active.evidence.commit}`);
      }
      lines.push('');
      lines.push(`Content  : ${text}`);
    }
  } else if (detail.kind === 'request') {
    const req = snapshot.usage.requests.find((r) => r.id === detail.id);
    if (req === undefined) {
      lines.push('Request record not found.');
    } else {
      lines.push(`ID       : ${req.id} (step ${req.step}, attempt ${req.attempt})`);
      lines.push(`Model    : ${req.model} (${req.provider}) [${req.purpose}]`);
      lines.push(`Status   : ${req.status}`);
      lines.push(`Timing   : latency ${formatDuration(req.latencyMs)}, TTFT ${formatDuration(req.firstEventMs)}`);
      lines.push(`Tokens   : in ${formatTokens(req.inputTokens)}, out ${formatTokens(req.outputTokens)}, cached ${formatTokens(req.cachedInputTokens)}, reasoning ${formatTokens(req.reasoningTokens)}`);
      lines.push(`Cost     : ${formatUsd(req.costUsd, req.costEstimated)}`);
      if (req.unpricedReason !== undefined) lines.push(`Unpriced : ${req.unpricedReason}`);
      if (req.error !== undefined) lines.push(`Error    : ${req.error}`);
    }
  } else if (detail.kind === 'tool') {
    const call = snapshot.execution.toolCalls.find((c) => c.callId === detail.id);
    if (call === undefined) {
      lines.push('Tool execution not found.');
    } else {
      lines.push(`Call     : ${call.name} (${call.callId}, step ${call.step})`);
      lines.push(`Status   : ${call.status} (kind: ${call.kind}${call.sideEffect ? `, ${call.sideEffect}` : ''})`);
      lines.push(`Duration : ${formatDuration(call.durationMs)}  Sandbox: ${call.sandbox ?? 'N/A'}`);
      lines.push(`Perm     : basis=${call.permission.basis ?? 'N/A'}, decision=${call.permission.decision ?? 'N/A'}${call.permission.classifierVerdict ? `, classifier=${call.permission.classifierVerdict}` : ''}`);
      if (call.permission.denialReason !== undefined) lines.push(`Denial   : ${call.permission.denialReason}`);
      if (call.handle !== undefined) lines.push(`Handle   : ${call.handle} (bytes: ${call.outputBytes ?? 'N/A'}, truncated: ${String(call.truncated)})`);
      lines.push(`Args     : ${call.argsSummary}`);
      if (call.outputSummary !== '') lines.push(`Output   : ${call.outputSummary}`);
      if (call.error !== undefined) lines.push(`Error    : ${call.error}`);
    }
  }

  return (
    <Box flexDirection="column">
      <Text {...styleOf(['accent', 'bold'])}>DETAIL VIEW</Text>
      {lines.slice(0, Math.max(4, listRows + 4)).map((line, idx) => (
        <Text key={idx} wrap="truncate">
          {safe(line, innerWidth)}
        </Text>
      ))}
    </Box>
  );
};

export function InspectorView({ snapshot, ui, keys, columns, rows, fullscreen }: InspectorViewProps) {
  const innerWidth = Math.max(24, columns - 4);
  const wide = columns >= 96;
  const compact = columns < 60;
  const listRows = Math.max(4, rows - (fullscreen ? 13 : 15));
  const rowIds = inspectorRowIdsFor(snapshot, ui);
  const selected = resolveSelectedIndex(ui, rowIds);

  const renderOverview = () => {
    const barWidth = Math.max(10, Math.min(34, innerWidth - 18));
    const ctxBar = renderProgressBar(snapshot.context.utilization, barWidth);
    const activeMemCount = snapshot.memory.active.filter((m) => !m.excluded).length;
    const { toolSummary } = snapshot.execution;
    const leftLines = [
      `Model       : ${snapshot.session.model || 'N/A'} (${snapshot.session.provider})`,
      `Status      : ${snapshot.agent.status} (${snapshot.agent.phase}${snapshot.agent.phase.includes('step') ? '' : `, step ${snapshot.agent.step}`})`,
      `Context     : ${formatTokens(snapshot.context.currentTokens)} / ${formatTokens(snapshot.context.contextWindow)} tokens`,
      ctxBar,
      `Session cost: ${formatUsd(snapshot.usage.cost.totalUsd, snapshot.usage.cost.isEstimated)}`,
      `Cache hit   : ${formatPercent(snapshot.usage.cache.hitRatio)}`,
      `Compactions : ${snapshot.context.compactions.filter((c) => !c.rejected).length}`,
      `Active mem  : ${activeMemCount}`,
      `Tool calls  : ${toolSummary.total} (${toolSummary.succeeded} ok, ${toolSummary.failed} fail, ${toolSummary.running} running)`,
    ];

    const conditions = snapshot.execution.completionConditions;
    const warnings = snapshot.diagnostics;

    return (
      <Box flexDirection="column">
        {wide ? (
          <Box flexDirection="row">
            <Box flexDirection="column" width={Math.floor(innerWidth / 2)}>
              {leftLines.map((line, i) => (
                <Text key={i} wrap="truncate">
                  {safe(line, Math.floor(innerWidth / 2) - 1)}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column" width={innerWidth - Math.floor(innerWidth / 2)}>
              <Text {...styleOf(['bold'])}>Completion conditions</Text>
              {conditions.length === 0 ? (
                <Text {...styleOf(['dim'])}>  None declared</Text>
              ) : (
                conditions.slice(0, 4).map((c) => (
                  <Text key={c.id} wrap="truncate">
                    {safe(`  ${badgeForCondition(c.state)} ${c.command} (${formatDuration(c.durationMs)})`, innerWidth - Math.floor(innerWidth / 2) - 1)}
                  </Text>
                ))
              )}
              <Text> </Text>
              <Text {...styleOf(['bold'])}>Warnings ({warnings.length})</Text>
              {warnings.length === 0 ? (
                <Text {...styleOf(['dim'])}>  No inefficiencies detected</Text>
              ) : (
                warnings.slice(0, 4).map((w) => (
                  <Text key={w.id} {...diagnosticStyle(w.severity)} wrap="truncate">
                    {safe(`  ${badgeForSeverity(w.severity)} ${w.message}`, innerWidth - Math.floor(innerWidth / 2) - 1)}
                  </Text>
                ))
              )}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {leftLines.map((line, i) => (
              <Text key={i} wrap="truncate">
                {safe(line, innerWidth)}
              </Text>
            ))}
            <Text {...styleOf(['bold'])}>Completion conditions ({conditions.length})</Text>
            {conditions.length === 0 ? (
              <Text {...styleOf(['dim'])}>  None declared</Text>
            ) : (
              conditions.slice(0, 3).map((c) => (
                <Text key={c.id} wrap="truncate">
                  {safe(`  ${badgeForCondition(c.state)} ${c.command}`, innerWidth)}
                </Text>
              ))
            )}
            <Text {...styleOf(['bold'])}>Warnings ({warnings.length})</Text>
            {warnings.slice(0, 3).map((w) => (
              <Text key={w.id} {...diagnosticStyle(w.severity)} wrap="truncate">
                {safe(`  ${badgeForSeverity(w.severity)} ${w.message}`, innerWidth)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  };

  const renderContext = () => {
    const subTabs = (['breakdown', 'explorer', 'compactions'] as const).map((sub) =>
      sub === ui.contextSubView ? `[${sub}]` : sub,
    );
    const header = `Section: ${subTabs.join('  ')}   Current: ${formatTokens(snapshot.context.currentTokens)} / ${formatTokens(snapshot.context.contextWindow)} (${formatPercent(snapshot.context.utilization)})`;

    if (ui.contextSubView === 'breakdown') {
      const bar = renderStackedBar(snapshot.context.categories, compact ? 18 : 36);
      const cats = snapshot.context.categories.filter((c) => c.tokens > 0);
      const win = visibleWindow(cats, selected, Math.max(3, listRows - 3));
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          <Text wrap="truncate">{safe(`Composition: ${bar}`, innerWidth)}</Text>
          {cats.length === 0 ? (
            <Text {...styleOf(['dim'])}>No context token breakdown recorded yet.</Text>
          ) : (
            win.rows.map((cat, idx) => {
              const absIdx = win.start + idx;
              const prefix = absIdx === selected ? '>' : ' ';
              const line = `${prefix} ${cat.label.padEnd(20)} ${formatTokens(cat.tokens).padStart(8)}  ${formatPercent(cat.share).padStart(6)}`;
              return (
                <Text key={cat.key} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                  {safe(line, innerWidth)}
                </Text>
              );
            })
          )}
          {snapshot.context.suggestions.length > 0 && (
            <Text {...styleOf(['warning'])} wrap="truncate">
              {safe(`Hint: ${snapshot.context.suggestions[0]!.message}`, innerWidth)}
            </Text>
          )}
        </Box>
      );
    }

    if (ui.contextSubView === 'explorer') {
      const items = filteredSortedContextItems(snapshot, ui);
      const win = visibleWindow(items, selected, listRows);
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          <Text {...styleOf(['dim'])} wrap="truncate">
            {safe(`Explorer (${items.length} items, sort=${ui.contextSort}, filter=${ui.contextCategoryFilter})`, innerWidth)}
          </Text>
          {items.length === 0 ? (
            <Text {...styleOf(['dim'])}>No context items match the current filter.</Text>
          ) : (
            win.rows.map((item, idx) => {
              const absIdx = win.start + idx;
              const prefix = absIdx === selected ? '>' : ' ';
              const excludedTag = item.evicted ? ' [EXCL]' : '';
              const line = `${prefix} ${item.category.padEnd(18)} ${formatTokens(item.tokens).padStart(6)} ${formatPercent(item.share).padStart(6)} ${item.label}${excludedTag}`;
              return (
                <Text key={item.id} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                  {safe(line, innerWidth)}
                </Text>
              );
            })
          )}
        </Box>
      );
    }

    const compactions = snapshot.context.compactions;
    const win = visibleWindow(compactions, selected, listRows);
    return (
      <Box flexDirection="column">
        <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
        {compactions.length === 0 ? (
          <Text {...styleOf(['dim'])}>No compaction events recorded in this session.</Text>
        ) : (
          win.rows.map((comp, idx) => {
            const absIdx = win.start + idx;
            const prefix = absIdx === selected ? '>' : ' ';
            const status = comp.rejected ? `[REJECTED]` : `${formatTokens(comp.tokensBefore)} -> ${formatTokens(comp.tokensAfter)}`;
            const line = `${prefix} #${comp.seq} ${comp.reason}  ${status}  saved=${formatTokens(comp.savedTokens)}  ${formatDuration(comp.durationMs)}`;
            return (
              <Text key={comp.id} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                {safe(line, innerWidth)}
              </Text>
            );
          })
        )}
      </Box>
    );
  };

  const renderMemory = () => {
    const subTabs = (['active', 'trace', 'lifecycle', 'all'] as const).map((sub) =>
      sub === ui.memorySubView ? `[${sub}]` : sub,
    );
    const header = `Section: ${subTabs.join('  ')}   Active: ${snapshot.memory.active.length}   All: ${snapshot.memory.allMemories.length}`;

    if (ui.memorySubView === 'active') {
      const items = snapshot.memory.active;
      const win = visibleWindow(items, selected, listRows);
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          {items.length === 0 ? (
            <Text {...styleOf(['dim'])}>No memories loaded into active context.</Text>
          ) : (
            win.rows.map((mem, idx) => {
              const absIdx = win.start + idx;
              const prefix = absIdx === selected ? '>' : ' ';
              const tags = `${mem.pinned ? '[PIN]' : ''}${mem.excluded ? '[EXCL]' : ''}`;
              const line = `${prefix} ${mem.status.padEnd(10)} ${formatTokens(mem.tokens).padStart(5)}t ${tags} ${mem.summary}`;
              return (
                <Text key={mem.id} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                  {safe(line, innerWidth)}
                </Text>
              );
            })
          )}
        </Box>
      );
    }

    if (ui.memorySubView === 'trace') {
      const trace = snapshot.memory.retrievalTrace;
      if (trace === null) {
        return (
          <Box flexDirection="column">
            <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
            <Text {...styleOf(['dim'])}>No memory retrieval trace recorded yet. Use search to query memories.</Text>
          </Box>
        );
      }
      const win = visibleWindow(trace.candidates, selected, Math.max(3, listRows - 2));
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          <Text wrap="truncate">
            {safe(`Query: "${trace.query}" | Candidates: ${trace.candidateCount} | Selected: ${trace.selectedCount} | Latency: ${formatDuration(trace.latencyMs)}`, innerWidth)}
          </Text>
          {win.rows.map((cand, idx) => {
            const absIdx = win.start + idx;
            const prefix = absIdx === selected ? '>' : ' ';
            const line = `${prefix} #${cand.rank} T${cand.tier} ${cand.decision.toUpperCase().padEnd(8)} ${cand.reason.padEnd(16)} ${cand.summary}`;
            return (
              <Text key={cand.id} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                {safe(line, innerWidth)}
              </Text>
            );
          })}
        </Box>
      );
    }

    if (ui.memorySubView === 'lifecycle') {
      const items = [...snapshot.memory.lifecycle].reverse();
      const win = visibleWindow(items, selected, listRows);
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          {items.length === 0 ? (
            <Text {...styleOf(['dim'])}>No memory lifecycle events in this session.</Text>
          ) : (
            win.rows.map((ev, idx) => {
              const absIdx = win.start + idx;
              const prefix = absIdx === selected ? '>' : ' ';
              const line = `${prefix} ${formatTimestamp(ev.at)} ${ev.kind.padEnd(16)} ${ev.summary}`;
              return (
                <Text key={ev.id} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                  {safe(line, innerWidth)}
                </Text>
              );
            })
          )}
        </Box>
      );
    }

    const all = filteredMemories(snapshot, ui);
    const win = visibleWindow(all, selected, listRows);
    const excludedSet = new Set(snapshot.memory.sessionControls.excludedIds);
    const pinnedSet = new Set(snapshot.memory.sessionControls.pinnedIds);
    return (
      <Box flexDirection="column">
        <Text {...styleOf(['bold'])} wrap="truncate">{safe(`${header}   filter=${ui.memoryFilter}`, innerWidth)}</Text>
        {all.length === 0 ? (
          <Text {...styleOf(['dim'])}>No stored memories match the filter.</Text>
        ) : (
          win.rows.map((mem, idx) => {
            const absIdx = win.start + idx;
            const prefix = absIdx === selected ? '>' : ' ';
            const tags = `${pinnedSet.has(mem.id) ? '[PIN]' : ''}${excludedSet.has(mem.id) ? '[EXCL]' : ''}`;
            const line = `${prefix} ${String(mem.state).padEnd(9)} ${mem.status.padEnd(10)} ${tags} ${mem.text}`;
            return (
              <Text key={mem.id} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                {safe(line, innerWidth)}
              </Text>
            );
          })
        )}
      </Box>
    );
  };

  const renderUsage = () => {
    const subTabs = (['tokens', 'cache', 'cost', 'requests'] as const).map((sub) =>
      sub === ui.usageSubView ? `[${sub}]` : sub,
    );
    const header = `Section: ${subTabs.join('  ')}   Total: ${formatTokens(snapshot.usage.totals.totalTokens)}   Cost: ${formatUsd(snapshot.usage.cost.totalUsd, snapshot.usage.cost.isEstimated)}`;
    const { totals, cache, cost, requests } = snapshot.usage;

    if (ui.usageSubView === 'tokens') {
      const spark = renderSparkline(requests.map((r) => r.inputTokens), compact ? 12 : 24);
      const lines = [
        `Input tokens      : ${formatTokens(totals.inputTokens)}`,
        `Output tokens     : ${formatTokens(totals.outputTokens)}`,
        `Total tokens      : ${formatTokens(totals.totalTokens)}`,
        `Cached input      : ${formatTokens(totals.cachedInputTokens)}`,
        `Cache read        : ${formatTokens(totals.cacheReadTokens)}`,
        `Cache write       : ${formatTokens(totals.cacheWriteTokens)}`,
        `Uncached input    : ${formatTokens(totals.uncachedInputTokens)}`,
        `Reasoning tokens  : ${formatTokens(totals.reasoningTokens)}`,
        `Input trend       : ${spark} (${requests.length} requests)`,
      ];
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          {lines.map((line, i) => (
            <Text key={i} wrap="truncate">
              {safe(line, innerWidth)}
            </Text>
          ))}
        </Box>
      );
    }

    if (ui.usageSubView === 'cache') {
      const breaks = Object.entries(cache.cacheBreaks).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
      const misses = Object.entries(cache.cacheMissCauses).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
      const lines = [
        `Cache hit ratio   : ${formatPercent(cache.hitRatio)}`,
        `Cache read tokens : ${formatTokens(totals.cacheReadTokens)}`,
        `Cache write tokens: ${formatTokens(totals.cacheWriteTokens)}`,
        `Estimated savings : ${formatUsd(cache.estimatedSavingsUsd)} (${cache.savingsBasis})`,
        `Not reported calls: ${cache.cacheReadNotReportedCalls}`,
        `Inconsistent calls: ${cache.inconsistentUsageCalls}`,
        `Cache breaks      : ${breaks}`,
        `Miss causes       : ${misses}`,
      ];
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          {lines.map((line, i) => (
            <Text key={i} wrap="truncate">
              {safe(line, innerWidth)}
            </Text>
          ))}
        </Box>
      );
    }

    if (ui.usageSubView === 'cost') {
      const rowsList = cost.byModel;
      const win = visibleWindow(rowsList, selected, Math.max(3, listRows - 4));
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          <Text wrap="truncate">
            {safe(`Session: ${formatUsd(cost.totalUsd, cost.isEstimated)}  Compaction: ${formatUsd(cost.compactionCostUsd)}  Unpriced: ${cost.unpricedCalls}`, innerWidth)}
          </Text>
          {cost.unpricedReasons.length > 0 && (
            <Text {...styleOf(['dim'])} wrap="truncate">
              {safe(`Unpriced reasons: ${cost.unpricedReasons.join('; ')}`, innerWidth)}
            </Text>
          )}
          <Text {...styleOf(['bold'])}>By model</Text>
          {rowsList.length === 0 ? (
            <Text {...styleOf(['dim'])}>No billed calls recorded yet.</Text>
          ) : (
            win.rows.map((m, idx) => {
              const absIdx = win.start + idx;
              const prefix = absIdx === selected ? '>' : ' ';
              const line = `${prefix} ${m.model} (${m.provider}) calls=${m.calls} in=${formatTokens(m.inputTokens)} out=${formatTokens(m.outputTokens)} ${formatUsd(m.costUsd, m.costEstimated)}`;
              return (
                <Text key={`${m.provider}:${m.model}`} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                  {safe(line, innerWidth)}
                </Text>
              );
            })
          )}
        </Box>
      );
    }

    const reversed = [...requests].reverse();
    const win = visibleWindow(reversed, selected, listRows);
    return (
      <Box flexDirection="column">
        <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
        {reversed.length === 0 ? (
          <Text {...styleOf(['dim'])}>No model requests recorded yet.</Text>
        ) : (
          win.rows.map((req, idx) => {
            const absIdx = win.start + idx;
            const prefix = absIdx === selected ? '>' : ' ';
            const line = `${prefix} s${req.step}.${req.attempt} ${req.status.padEnd(10)} ${req.model} in=${formatTokens(req.inputTokens)} out=${formatTokens(req.outputTokens)} ${formatDuration(req.latencyMs)} ${formatUsd(req.costUsd, req.costEstimated)}`;
            return (
              <Text key={req.id} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                {safe(line, innerWidth)}
              </Text>
            );
          })
        )}
      </Box>
    );
  };

  const renderExecution = () => {
    const subTabs = (['tools', 'verification', 'plan'] as const).map((sub) =>
      sub === ui.executionSubView ? `[${sub}]` : sub,
    );
    const { toolSummary } = snapshot.execution;
    const header = `Section: ${subTabs.join('  ')}   Tools: ${toolSummary.total} ok=${toolSummary.succeeded} fail=${toolSummary.failed} run=${toolSummary.running}`;

    if (ui.executionSubView === 'tools') {
      const calls = filteredToolCalls(snapshot, ui);
      const win = visibleWindow(calls, selected, listRows);
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(`${header}   filter=${ui.executionFilter}`, innerWidth)}</Text>
          {calls.length === 0 ? (
            <Text {...styleOf(['dim'])}>No tool executions match the filter.</Text>
          ) : (
            win.rows.map((call, idx) => {
              const absIdx = win.start + idx;
              const prefix = absIdx === selected ? '>' : ' ';
              const line = `${prefix} ${badgeForToolStatus(call.status)} ${call.name.padEnd(14)} ${formatDuration(call.durationMs).padStart(7)} ${call.argsSummary}`;
              return (
                <Text key={call.callId} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                  {safe(line, innerWidth)}
                </Text>
              );
            })
          )}
        </Box>
      );
    }

    if (ui.executionSubView === 'verification') {
      const conds = snapshot.execution.completionConditions;
      const win = visibleWindow(conds, selected, Math.max(3, listRows - 2));
      return (
        <Box flexDirection="column">
          <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
          <Text {...styleOf(['dim'])} wrap="truncate">
            {safe(`Requirements: ${snapshot.execution.requirements.length === 0 ? 'none' : snapshot.execution.requirements.join('; ')}`, innerWidth)}
          </Text>
          {conds.length === 0 ? (
            <Text {...styleOf(['dim'])}>No completion conditions declared.</Text>
          ) : (
            win.rows.map((cond, idx) => {
              const absIdx = win.start + idx;
              const prefix = absIdx === selected ? '>' : ' ';
              const line = `${prefix} ${badgeForCondition(cond.state)} r${cond.rounds} ${formatDuration(cond.durationMs).padStart(7)} ${cond.command}`;
              return (
                <Text key={cond.id} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                  {safe(line, innerWidth)}
                </Text>
              );
            })
          )}
        </Box>
      );
    }

    const plan = snapshot.execution.plan;
    const win = visibleWindow(plan, selected, listRows);
    return (
      <Box flexDirection="column">
        <Text {...styleOf(['bold'])} wrap="truncate">{safe(header, innerWidth)}</Text>
        {plan.length === 0 ? (
          <Text {...styleOf(['dim'])}>No active plan recorded.</Text>
        ) : (
          win.rows.map((entry, idx) => {
            const absIdx = win.start + idx;
            const prefix = absIdx === selected ? '>' : ' ';
            const badge = entry.status === 'completed' ? '[DONE]' : entry.status === 'in_progress' ? '[WIP ]' : '[TODO]';
            const line = `${prefix} ${badge} (${entry.priority}) ${entry.content}`;
            return (
              <Text key={absIdx} {...(absIdx === selected ? styleOf(['choice.selected']) : {})} wrap="truncate">
                {safe(line, innerWidth)}
              </Text>
            );
          })
        )}
      </Box>
    );
  };

  const tabBar = (
    <Box flexDirection="row">
      {INSPECTOR_TABS.map((tab: InspectorTab, index: number) => {
        const active = tab === ui.tab;
        const label = active ? `[${index + 1}:${INSPECTOR_TAB_TITLES[tab]}]` : ` ${index + 1}:${INSPECTOR_TAB_TITLES[tab]} `;
        return (
          <Text key={tab} {...(active ? styleOf(['accent', 'bold']) : styleOf(['dim']))}>
            {label}{' '}
          </Text>
        );
      })}
    </Box>
  );

  const liveBadge = ui.loading ? 'REFRESHING' : snapshot.meta.liveConnected ? 'LIVE' : 'OFFLINE';

  return (
    <Box flexDirection="column" borderStyle="round" {...borderOf('border')} paddingX={1} width={columns}>
      <Text {...styleOf(['accent', 'bold'])} wrap="truncate">
        {safe(`MOMONGACODE / AGENT INSPECTOR   [${liveBadge}]${snapshot.meta.droppedEvents > 0 ? `   dropped=${snapshot.meta.droppedEvents}` : ''}`, innerWidth)}
      </Text>
      {tabBar}
      <Text {...styleOf(['dim'])} wrap="truncate">
        {'─'.repeat(Math.max(10, innerWidth))}
      </Text>

      {ui.error !== null && (
        <Text {...styleOf(['error'])} wrap="truncate">
          {safe(`Error: ${ui.error}`, innerWidth)}
        </Text>
      )}

      {ui.detail !== null ? (
        renderDetailPanel(snapshot, ui, innerWidth, listRows)
      ) : ui.tab === 'overview' ? (
        renderOverview()
      ) : ui.tab === 'context' ? (
        renderContext()
      ) : ui.tab === 'memory' ? (
        renderMemory()
      ) : ui.tab === 'usage' ? (
        renderUsage()
      ) : (
        renderExecution()
      )}

      {ui.statusMessage !== null && (
        <Text {...styleOf(['notice'])} wrap="truncate">
          {safe(ui.statusMessage, innerWidth)}
        </Text>
      )}
      <Text {...styleOf(['dim'])} wrap="truncate">
        {safe(inspectorFooterHints(keys, ui), innerWidth)}
      </Text>
    </Box>
  );
}
