import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { factsStore } from './run-facts-fixture.ts';
import { testKernelLock } from '@momonga/testkit';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

export type Claim = 'executed' | 'any';

export type FidelityReply = { lastSeq: number; attested: string[]; unreadable: { handle: string; reason: string }[]; checkedThrough: number; verdicts: unknown[] };

const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const clients: JournalThreadClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

export const startedCall = (callId: string, rawInput: Record<string, unknown>, output = 'ok', extra: Record<string, unknown> = {}): RunEventPayload[] =>
  [
    { type: 'tool.call', callId, providerCallId: callId, name: 'Sh', kind: 'other', title: callId, rawInput },
    { type: 'tool.started', callId, idemKey: `key-${callId}`, basis: 'read_only' },
    { type: 'tool.completed', callId, status: 'completed', output, ...extra },
  ] as RunEventPayload[];

export const unfinishedCall = (callId: string, rawInput: Record<string, unknown>): RunEventPayload[] =>
  [
    { type: 'tool.call', callId, providerCallId: callId, name: 'Sh', kind: 'other', title: callId, rawInput },
    { type: 'tool.started', callId, idemKey: `key-${callId}`, basis: 'read_only' },
  ] as RunEventPayload[];

export const reconciledCall = (callId: string, rawInput: Record<string, unknown>, outcome: 'already_applied' | 'not_applied' | 'unknown', output: string): RunEventPayload[] =>
  [...unfinishedCall(callId, rawInput), { type: 'tool.reconciled', callId, outcome, output }] as RunEventPayload[];

export const deniedCall = (callId: string, rawInput: Record<string, unknown>): RunEventPayload[] =>
  [
    { type: 'tool.call', callId, providerCallId: callId, name: 'Sh', kind: 'other', title: callId, rawInput },
    { type: 'tool.completed', callId, status: 'failed', output: 'Permission denied: rule', denial: { source: 'rule', reason: 'rule' } },
  ] as RunEventPayload[];

export const rejectedCall = (callId: string, rawInput: Record<string, unknown>): RunEventPayload[] =>
  [
    { type: 'tool.call', callId, providerCallId: callId, name: 'Sh', kind: 'other', title: callId, rawInput },
    { type: 'tool.completed', callId, status: 'failed', output: 'The user rejected this tool call.' },
  ] as RunEventPayload[];

export const modelSaid = (step: number, text: string): RunEventPayload[] => [
  { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { tool_choice: 'auto' } },
  {
    type: 'model.responded',
    step,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: `m${step}`, role: 'assistant', content: [{ type: 'output_text', text }] }], usage: USAGE },
  },
];

export const fidelityEnv = async () => {
  const env = await factsStore();
  const blobsDir = path.join(env.dir, 'blobs');
  const fidelity = async (runId: string, tokens: readonly { token: string; claim: Claim }[], throughEventSeq?: number): Promise<FidelityReply> => {
    const { dev, ino } = fs.statSync(env.dbPath);
    const client = await startJournalThread({ lock: testKernelLock(), busyTimeoutMs: BUSY_WAIT_LIMIT_MS, databasePath: env.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS, blobsDir } as Parameters<typeof startJournalThread>[0]);
    clients.push(client);
    const through = throughEventSeq ?? env.store.getRun(runId)?.lastSeq ?? 0;
    return (await client.request({ kind: 'fidelity', runId, throughEventSeq: through, cwd: env.project, tokens: tokens.map((entry) => ({ ...entry })) })) as unknown as FidelityReply;
  };
  return { ...env, blobsDir, fidelity };
};
