import type { InspectorContextCategory, InspectorDiagnosticSeverity, InspectorTab } from '@momonga/protocol';

export const INSPECTOR_TAB_TITLES: Readonly<Record<InspectorTab, string>> = {
  overview: 'Overview',
  context: 'Context',
  memory: 'Memory',
  usage: 'Usage',
  execution: 'Execution',
};

const STACK_GLYPHS = ['█', '▓', '▒', '░', '▪', '·'] as const;
const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export const truncateText = (text: string, maxWidth: number): string => {
  if (maxWidth <= 0) return '';
  const clean = text.replace(/[\r\n]+/g, ' ');
  if (clean.length <= maxWidth) return clean;
  if (maxWidth === 1) return '…';
  return `${clean.slice(0, maxWidth - 1)}…`;
};

export const formatTokens = (value: number | null | undefined): string =>
  value === null || value === undefined ? 'N/A' : value.toLocaleString('en-US');

export const formatPercent = (ratio: number | null | undefined): string =>
  ratio === null || ratio === undefined || !Number.isFinite(ratio) ? 'N/A' : `${(ratio * 100).toFixed(1)}%`;

export const formatUsd = (amount: number | null | undefined, estimated = false): string => {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return 'N/A';
  const digits = amount > 0 && amount < 0.01 ? 4 : 3;
  return `$${amount.toFixed(digits)}${estimated ? ' (est)' : ''}`;
};

export const formatDuration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'N/A';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const formatTimestamp = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'N/A';
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

export const renderProgressBar = (ratio: number | null | undefined, width: number): string => {
  const inner = Math.max(8, Math.min(40, width));
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return `[${'░'.repeat(inner)}] N/A`;
  }
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * inner);
  return `[${'█'.repeat(filled)}${'░'.repeat(inner - filled)}] ${(clamped * 100).toFixed(1)}%`;
};

export const renderStackedBar = (categories: readonly InspectorContextCategory[], width: number): string => {
  const inner = Math.max(10, Math.min(48, width));
  const positive = categories.filter((c) => c.tokens > 0);
  if (positive.length === 0) return `[${'░'.repeat(inner)}]`;
  const total = positive.reduce((sum, c) => sum + c.tokens, 0);
  if (total <= 0) return `[${'░'.repeat(inner)}]`;

  const chars: string[] = [];
  let used = 0;
  for (let i = 0; i < positive.length && used < inner; i += 1) {
    const cat = positive[i]!;
    const glyph = STACK_GLYPHS[i % STACK_GLYPHS.length]!;
    const rawSpan = i === positive.length - 1 ? inner - used : Math.round((cat.tokens / total) * inner);
    const span = Math.max(cat.tokens > 0 && rawSpan === 0 && used < inner ? 1 : 0, Math.min(inner - used, rawSpan));
    for (let j = 0; j < span; j += 1) chars.push(glyph);
    used += span;
  }
  while (chars.length < inner) chars.push('░');
  return `[${chars.join('')}]`;
};

export const renderSparkline = (values: readonly (number | null)[], width: number): string => {
  const slice = values.slice(-Math.max(4, width));
  const numeric = slice.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  if (numeric.length === 0) return 'N/A';
  const max = Math.max(...numeric, 1);
  return slice
    .map((value) => {
      if (value === null || !Number.isFinite(value) || value < 0) return '·';
      const idx = Math.min(SPARK_GLYPHS.length - 1, Math.floor((value / max) * (SPARK_GLYPHS.length - 1)));
      return SPARK_GLYPHS[idx]!;
    })
    .join('');
};

export const badgeForSeverity = (severity: InspectorDiagnosticSeverity): string => {
  if (severity === 'critical') return '[CRIT]';
  if (severity === 'warning') return '[WARN]';
  return '[INFO]';
};

export const badgeForCondition = (state: string): string => {
  if (state === 'passed') return '[PASS]';
  if (state === 'failed' || state === 'timed_out' || state === 'spawn_error' || state === 'cancelled') return '[FAIL]';
  if (state === 'running') return '[RUN ]';
  if (state === 'stale') return '[STAL]';
  return '[SKIP]';
};

export const badgeForToolStatus = (status: string): string => {
  if (status === 'completed') return '[OK  ]';
  if (status === 'failed') return '[FAIL]';
  if (status === 'denied') return '[DENY]';
  if (status === 'awaiting_approval') return '[HOLD]';
  if (status === 'awaiting_input') return '[WAIT]';
  if (status === 'running' || status === 'requested') return '[RUN ]';
  return '[RECN]';
};

export const visibleWindow = <T>(items: readonly T[], selected: number, maxRows: number): { start: number; rows: readonly T[] } => {
  const height = Math.max(1, maxRows);
  if (items.length <= height) return { start: 0, rows: items };
  const clamped = Math.max(0, Math.min(selected, items.length - 1));
  const start = Math.max(0, Math.min(items.length - height, clamped - Math.floor(height / 2)));
  return { start, rows: items.slice(start, start + height) };
};
