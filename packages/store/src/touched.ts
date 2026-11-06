import type { RunEvent, TouchedTarget } from '@momonga/protocol';

type ToolCallEvent = Extract<RunEvent, { type: 'tool.call' }>;

const FILE_KINDS: readonly ToolCallEvent['kind'][] = ['read', 'edit', 'delete', 'move'];

export const touchedTargetsOf = (event: ToolCallEvent): TouchedTarget[] => {
  const locations = event.locations ?? [];
  if (FILE_KINDS.includes(event.kind)) return locations.map((location): TouchedTarget => ({ kind: 'file', path: location.path }));
  if (event.kind === 'search') return locations.length === 0 ? [{ kind: 'directory' }] : locations.map((location): TouchedTarget => ({ kind: 'directory', path: location.path }));
  if (event.kind === 'execute') return [{ kind: 'directory' }];
  return [];
};
