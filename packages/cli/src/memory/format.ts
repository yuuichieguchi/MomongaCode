import type { MemoryView } from '@momonga/protocol';

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

const placeOf = (memory: MemoryView): string => (memory.project === null ? memory.scope : `${memory.scope} ${memory.project}`);

export const formatMemoryList = (memories: readonly MemoryView[]): string =>
  memories.length === 0 ? 'no memories' : memories.map((memory) => `${memory.id}  [${placeOf(memory)}]  ${firstLine(memory.text)}`).join('\n');

export const formatMemory = (memory: MemoryView): string =>
  [
    `id: ${memory.id}`,
    `scope: ${memory.scope}`,
    ...(memory.project === null ? [] : [`project: ${memory.project}`]),
    `created: ${new Date(memory.createdAt).toISOString()}`,
    `last used: ${new Date(memory.lastUsedAt).toISOString()}`,
    `source: session ${memory.source.sessionId}, run ${memory.source.runId}, step ${memory.source.step}, call ${memory.source.callId}, event ${memory.source.seq}`,
    '',
    memory.text,
  ].join('\n');
