import type { MemoryView } from '@momonga/protocol';

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

const placeOf = (memory: MemoryView): string => (memory.project === null ? memory.scope : `${memory.scope} ${memory.project}`);

export const formatMemoryList = (memories: readonly MemoryView[]): string =>
  memories.length === 0 ? 'no memories' : memories.map((memory) => `${memory.id}  [${placeOf(memory)}]  ${firstLine(memory.text)}`).join('\n');

const sourceLine = (source: MemoryView['source']): string =>
  source.kind === 'tool'
    ? `source: session ${source.sessionId}, run ${source.runId}, step ${source.step}, call ${source.callId}, event ${source.seq}`
    : `source: session ${source.sessionId}, run ${source.runId}, reflection candidate ${source.ordinal}`;

export const formatMemory =(memory: MemoryView): string =>
  [
    `id: ${memory.id}`,
    `scope: ${memory.scope}`,
    `origin: ${memory.origin}`,
    ...(memory.project === null ? [] : [`project: ${memory.project}`]),
    `created: ${new Date(memory.createdAt).toISOString()}`,
    `last used: ${new Date(memory.lastUsedAt).toISOString()}`,
    sourceLine(memory.source),
    '',
    memory.text,
  ].join('\n');
