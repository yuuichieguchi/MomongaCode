import { describeMemoryValidity, escapeTerminalLine } from '@momonga/protocol';
import type { MemoryView, ReflectionDrop, ReflectionJobView } from '@momonga/protocol';

const firstLine = (text: string): string => escapeTerminalLine(text.split('\n')[0] ?? '');

const placeOf = (memory: MemoryView): string => (memory.project === null ? memory.scope : `${memory.scope} ${escapeTerminalLine(memory.project)}`);

const statusOf = (memory: MemoryView): string => (memory.status === 'unbound' ? '' : `${memory.status}  `);

export const formatMemoryList = (memories: readonly MemoryView[]): string =>
  memories.length === 0 ? 'no memories' : memories.map((memory) => `${memory.id}  [${placeOf(memory)}]  ${statusOf(memory)}${firstLine(memory.text)}`).join('\n');

const iso = (ms: number): string => new Date(ms).toISOString();

export const formatMemoryHistory = (memories: readonly MemoryView[]): string =>
  memories.length === 0
    ? 'no memories'
    : memories.map((memory) => `${memory.id}  ${memory.status}  saved ${iso(memory.createdAt)}${describeMemoryValidity(memory)}  ${firstLine(memory.text)}`).join('\n');

const evidenceLine = (entry: MemoryView['evidence'][number]): string => {
  switch (entry.kind) {
    case 'file':
      return `evidence: file ${escapeTerminalLine(entry.path)} (${escapeTerminalLine(entry.sha256)})`;
    case 'commit':
      return `evidence: commit ${escapeTerminalLine(entry.sha)}`;
    case 'check':
      return `evidence: check ${escapeTerminalLine(entry.command)} exited ${entry.exitCode} (run ${entry.runId}, event ${entry.seq})`;
  }
};

const sourceLine = (source: MemoryView['source']): string => {
  switch (source.kind) {
    case 'tool':
      return `source: session ${source.sessionId}, run ${source.runId}, step ${source.step}, call ${source.callId}, event ${source.seq}`;
    case 'reflection':
      return `source: session ${source.sessionId}, run ${source.runId}, reflection candidate ${source.ordinal}`;
    case 'command':
      return `source: added by a person with momonga memory add at ${new Date(source.at).toISOString()}`;
  }
};

const DROP_CAUSE_LABELS: Record<ReflectionDrop['cause'], string> = {
  text_rule: 'refused by the text rule',
  duplicate: 'already known',
  evidence: 'evidence could not be bound',
};

const droppedLine = (drop: ReflectionDrop): string =>
  `  candidate ${drop.ordinal} dropped, ${DROP_CAUSE_LABELS[drop.cause]}: ${escapeTerminalLine(drop.reason)}${drop.text === null ? '' : `\n    "${firstLine(drop.text)}"`}`;

export const formatReflection = (job: ReflectionJobView | null): string => {
  if (job === null) return 'no reflection has run in this folder yet';
  const headline = `the last reflection of this folder (run ${job.runId}, ${iso(job.updatedAt)}) is ${job.state}`;
  const reason = job.reason === null ? [] : [`  ${escapeTerminalLine(job.reason)}`];
  return [headline, ...reason, ...job.dropped.map(droppedLine)].join('\n');
};

export const formatMemory = (memory: MemoryView): string =>
  [
    `id: ${memory.id}`,
    `scope: ${memory.scope}`,
    `origin: ${memory.origin}`,
    `kind: ${memory.kind}`,
    `status: ${memory.status}`,
    ...(memory.project === null ? [] : [`project: ${escapeTerminalLine(memory.project)}`]),
    `created: ${iso(memory.createdAt)}`,
    `last used: ${iso(memory.lastUsedAt)}`,
    sourceLine(memory.source),
    ...memory.evidence.map(evidenceLine),
    '',
    memory.text,
  ].join('\n');
