import type { MemoryView } from '@momonga/protocol';

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

const placeOf = (memory: MemoryView): string => (memory.project === null ? memory.scope : `${memory.scope} ${memory.project}`);

const statusOf = (memory: MemoryView): string => (memory.status === 'unbound' ? '' : `${memory.status}  `);

export const formatMemoryList = (memories: readonly MemoryView[]): string =>
  memories.length === 0 ? 'no memories' : memories.map((memory) => `${memory.id}  [${placeOf(memory)}]  ${statusOf(memory)}${firstLine(memory.text)}`).join('\n');

const iso = (ms: number): string => new Date(ms).toISOString();

const validityOf = (memory: MemoryView): string =>
  [
    ...(memory.state === 'active' ? [] : [`state ${memory.state}`]),
    ...(memory.retiredAt === null ? [] : [`retired ${iso(memory.retiredAt)}`]),
    ...(memory.supersedes.length === 0 ? [] : [`supersedes ${memory.supersedes.join(' ')}`]),
  ]
    .map((part) => `, ${part}`)
    .join('');

export const formatMemoryHistory = (memories: readonly MemoryView[]): string =>
  memories.length === 0
    ? 'no memories'
    : memories.map((memory) => `${memory.id}  ${memory.status}  saved ${iso(memory.createdAt)}${validityOf(memory)}  ${firstLine(memory.text)}`).join('\n');

const evidenceLine = (entry: MemoryView['evidence'][number]): string => {
  switch (entry.kind) {
    case 'file':
      return `evidence: file ${entry.path} (${entry.sha256})`;
    case 'commit':
      return `evidence: commit ${entry.sha}`;
    case 'check':
      return `evidence: check ${entry.command} exited ${entry.exitCode} (run ${entry.runId}, event ${entry.seq})`;
  }
};

const sourceLine = (source: MemoryView['source']): string =>
  source.kind === 'tool'
    ? `source: session ${source.sessionId}, run ${source.runId}, step ${source.step}, call ${source.callId}, event ${source.seq}`
    : `source: session ${source.sessionId}, run ${source.runId}, reflection candidate ${source.ordinal}`;

export const formatMemory =(memory: MemoryView): string =>
  [
    `id: ${memory.id}`,
    `scope: ${memory.scope}`,
    `origin: ${memory.origin}`,
    `kind: ${memory.kind}`,
    `status: ${memory.status}`,
    ...(memory.project === null ? [] : [`project: ${memory.project}`]),
    `created: ${iso(memory.createdAt)}`,
    `last used: ${iso(memory.lastUsedAt)}`,
    sourceLine(memory.source),
    ...memory.evidence.map(evidenceLine),
    '',
    memory.text,
  ].join('\n');
