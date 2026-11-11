import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { compactionLossSignals } from '@momonga/memory';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';

const RUN = 'run-loss';

const journal = (payloads: readonly RunEventPayload[]): RunEvent[] =>
  payloads.map((payload, index) => ({ ...payload, id: index + 1, runId: RUN, sessionId: 's', seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent);

const call = (callId: string, name: string, rawInput: unknown): RunEventPayload => ({ type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: name, rawInput });
const started = (callId: string): RunEventPayload => ({ type: 'tool.started', callId, idemKey: `key-${callId}` });
const done = (callId: string, output = 'ok', status: 'completed' | 'failed' = 'completed', extra: Partial<Extract<RunEventPayload, { type: 'tool.completed' }>> = {}): RunEventPayload => ({
  type: 'tool.completed',
  callId,
  status,
  output,
  ...extra,
});
const compacted: RunEventPayload = { type: 'context.compacted', item: { type: 'message', role: 'user', content: 's' }, summary: 's', replacedThroughSeq: 1 };
const read = (id: string, path: string, content: string, range: { offset?: number; limit?: number } = {}): RunEventPayload[] => [
  call(id, 'Read', { file_path: path, ...range }),
  started(id),
  done(id, content, 'completed', { files: [{ path, sha256: sha256Hex(content), access: 'read' }] }),
];
const commandThrough = (name: string, id: string, command: string, status: 'completed' | 'failed'): RunEventPayload[] => [
  call(id, name, { command }),
  started(id),
  done(id, status === 'failed' ? 'boom' : 'ok', status, { exitCode: status === 'failed' ? 1 : 0, command }),
];
const bash = (id: string, command: string, status: 'completed' | 'failed'): RunEventPayload[] => commandThrough('Bash', id, command, status);
const denied = (id: string, input: unknown): RunEventPayload[] => [
  call(id, 'Write', input),
  done(id, 'Permission denied: x', 'failed', { denial: { source: 'rule', reason: 'x' } }),
];
const rejected = (id: string, input: unknown): RunEventPayload[] => [
  call(id, 'Write', input),
  {
    type: 'tool.permission.requested',
    approvalId: `approval-${id}`,
    callId: id,
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
    subjectDigest: 'digest',
    reason: 'edits require approval',
    shown: { title: 'approval', input: {} },
  },
  { type: 'tool.permission.resolved', approvalId: `approval-${id}`, optionId: 'reject_once' },
  done(id, 'The user rejected this tool call.', 'failed'),
];

const kindsOf = (payloads: readonly RunEventPayload[]): string[] => compactionLossSignals(journal(payloads)).map((signal) => signal.kind);

describe('compactionLossSignals', () => {
  it('finds nothing in a run without compaction', () => {
    expect(kindsOf([...read('a', '/p/x.ts', 'one'), ...read('b', '/p/x.ts', 'one')])).toEqual([]);
  });

  it('names the compaction seq and the seq of the call that lost', () => {
    const events = journal([...read('a', '/p/x.ts', 'one'), compacted, ...read('b', '/p/x.ts', 'one')]);
    expect(compactionLossSignals(events)).toEqual([{ kind: 'rediscovery', compactionSeq: 4, seq: 5 }]);
  });
});

describe('history_read', () => {
  it('fires for a range at or below the compaction', () => {
    expect(kindsOf([compacted, call('h', 'HistoryRead', { seqFrom: 1, seqTo: 1 })])).toEqual(['history_read']);
  });

  it.for([
    ['no range at all', {}],
    ['only seqTo', { seqTo: 50 }],
    ['only a step', { step: 3 }],
    ['only an offset', { offset: 100 }],
  ] as const)('fires for a read with %s, which covers the whole run', ([, input]) => {
    expect(kindsOf([compacted, call('h', 'HistoryRead', input)])).toEqual(['history_read']);
  });

  it('ignores a read with no range of another run', () => {
    expect(kindsOf([compacted, call('h', 'HistoryRead', { runId: 'other' })])).toEqual([]);
  });

  it('ignores a range above the compaction', () => {
    expect(kindsOf([compacted, call('h', 'HistoryRead', { seqFrom: 2, seqTo: 2 })])).toEqual([]);
  });

  it('ignores a read of another run', () => {
    expect(kindsOf([compacted, call('h', 'HistoryRead', { runId: 'other', seqFrom: 1, seqTo: 1 })])).toEqual([]);
  });

  it('ignores a read made before the compaction', () => {
    expect(kindsOf([call('h', 'HistoryRead', { seqFrom: 1, seqTo: 1 }), compacted])).toEqual([]);
  });
});

describe('rediscovery', () => {
  it('ignores a file whose hash changed', () => {
    expect(kindsOf([...read('a', '/p/x.ts', 'one'), compacted, ...read('b', '/p/x.ts', 'two')])).toEqual([]);
  });

  it('ignores page 2 of a file whose page 1 was read before the compaction', () => {
    const before = read('a', '/p/x.ts', 'one', { offset: 1, limit: 10 });
    expect(kindsOf([...before, compacted, ...read('b', '/p/x.ts', 'one', { offset: 11, limit: 10 })])).toEqual([]);
  });

  it.for([
    ['an overlapping page', { offset: 5, limit: 10 }],
    ['the whole file', {}],
  ] as const)('fires for %s read again with the same hash', ([, range]) => {
    const before = read('a', '/p/x.ts', 'one', { offset: 1, limit: 10 });
    expect(kindsOf([...before, compacted, ...read('b', '/p/x.ts', 'one', range)])).toEqual(['rediscovery']);
  });

  it('fires for a page read after the whole file was read before the compaction', () => {
    expect(kindsOf([...read('a', '/p/x.ts', 'one'), compacted, ...read('b', '/p/x.ts', 'one', { offset: 11, limit: 10 })])).toEqual(['rediscovery']);
  });

  it('ignores a different path with the same content', () => {
    expect(kindsOf([...read('a', '/p/x.ts', 'one'), compacted, ...read('b', '/p/y.ts', 'one')])).toEqual([]);
  });

  it('ignores a first read after the compaction', () => {
    expect(kindsOf([compacted, ...read('a', '/p/x.ts', 'one'), ...read('b', '/p/x.ts', 'one')])).toEqual([]);
  });

  it('ignores a read that failed before the compaction', () => {
    expect(kindsOf([call('a', 'Read', { file_path: '/p/x.ts' }), done('a', 'File does not exist', 'failed'), compacted, ...read('b', '/p/x.ts', 'one')])).toEqual([]);
  });
});

describe('repeated_failure', () => {
  it('ignores a failure of a call that never started, because the command did not run', () => {
    const neverStarted = (id: string): RunEventPayload[] => [call(id, 'Bash', { command: 'npm test' }), done(id, 'invalid arguments', 'failed')];
    expect(kindsOf([...neverStarted('a'), compacted, ...neverStarted('b')])).toEqual([]);
    expect(kindsOf([...bash('a', 'npm test', 'failed'), compacted, ...neverStarted('b')])).toEqual([]);
  });

  it('fires when the same command fails on both sides', () => {
    expect(kindsOf([...bash('a', 'npm test', 'failed'), compacted, ...bash('b', 'npm test', 'failed')])).toEqual(['repeated_failure']);
  });

  it('fires for a command run through a tool that is not named Bash, because the command is the one the boundary recorded', () => {
    const SHELL = 'mcp__remote__shell';
    expect(kindsOf([...commandThrough(SHELL, 'a', 'npm test', 'failed'), compacted, ...commandThrough(SHELL, 'b', 'npm test', 'failed')])).toEqual(['repeated_failure']);
    expect(kindsOf([...commandThrough(SHELL, 'a', 'npm test', 'failed'), compacted, ...bash('b', 'npm test', 'failed')])).toEqual(['repeated_failure']);
  });

  it('ignores a different command', () => {
    expect(kindsOf([...bash('a', 'npm test', 'failed'), compacted, ...bash('b', 'npm run lint', 'failed')])).toEqual([]);
  });

  it('ignores a command that now succeeds', () => {
    expect(kindsOf([...bash('a', 'npm test', 'failed'), compacted, ...bash('b', 'npm test', 'completed')])).toEqual([]);
  });

  it('ignores a command that succeeded before', () => {
    expect(kindsOf([...bash('a', 'npm test', 'completed'), compacted, ...bash('b', 'npm test', 'failed')])).toEqual([]);
  });
});

describe('instruction_drift', () => {
  const input = { file_path: '/p/x.ts', content: 'c' };

  it('fires when a denied call is repeated', () => {
    expect(kindsOf([...denied('a', input), compacted, call('b', 'Write', input)])).toEqual(['instruction_drift']);
  });

  it('fires when a rejected call is repeated', () => {
    expect(kindsOf([...rejected('a', input), compacted, call('b', 'Write', input)])).toEqual(['instruction_drift']);
  });

  it('ignores a call with other input', () => {
    expect(kindsOf([...denied('a', input), compacted, call('b', 'Write', { ...input, content: 'other' })])).toEqual([]);
  });

  it('ignores a repeat before the compaction', () => {
    expect(kindsOf([...denied('a', input), call('b', 'Write', input), compacted])).toEqual([]);
  });

  it('ignores a repeat of a call that was allowed', () => {
    expect(kindsOf([call('a', 'Write', input), done('a'), compacted, call('b', 'Write', input)])).toEqual([]);
  });
});
