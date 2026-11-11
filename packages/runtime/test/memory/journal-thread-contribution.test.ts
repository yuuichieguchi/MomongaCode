import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { JournalThreadError } from '@momonga/store';
import type { ContributionPreparer } from '@momonga/store';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { journalReaderPreparer, makeEnv } from '../worker/harness.ts';
import { testKernelLock } from '@momonga/testkit';

vi.setConfig({ testTimeout: 60_000 });

const callOf = (index: number): RunEventPayload => ({ type: 'tool.call', callId: `save_${index}`, providerCallId: `save_${index}`, name: 'MemorySave', kind: 'other', title: 'save', rawInput: {} });

const responded = (text: string): RunEventPayload => ({
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: {
    status: 'completed',
    output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
});

const throughTheThread = (dbPath: () => string): { preparer: ContributionPreparer; close(): Promise<void> } => {
  let started: Promise<JournalThreadClient> | undefined;
  const client = (): Promise<JournalThreadClient> => {
    started ??= (() => {
      const databasePath = dbPath();
      const { dev, ino } = fs.statSync(databasePath);
      return startJournalThread({ lock: testKernelLock(), databasePath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
    })();
    return started;
  };
  return {
    preparer: {
      measure: async (request) => (await client()).measure(request),
      inheritPlan: async (request) => (await client()).inheritPlan(request),
      inheritedWindow: async (request) => (await client()).inheritedWindow(request),
      verdict: async (request) => (await client()).verdict(request),
      evidence: async (request) => (await client()).evidence(request),
      reflectionInput: async (request) => (await client()).reflectionInput(request),
      fidelity: async (request) => (await client()).fidelity(request),
      report: async (request) => (await client()).report(request),
    },
    close: async () => {
      if (started !== undefined) await (await started).close();
    },
  };
};

describe('the contribution handler of the embedded journal thread', () => {
  it('answers with the lastSeq it read and the items the in-process reader finds for the same journal, and carries only items back', async () => {
    let dbPath = '';
    const thread = throughTheThread(() => dbPath);
    const env = await makeEnv({ preparer: thread.preparer });
    dbPath = env.dbPath;
    const saver = env.enqueue('Save notes', { history: 'fresh' });
    const saverClaim = await env.seed(saver.id, [callOf(0), callOf(1)], 'hold');
    const memoryIds = await Promise.all([0, 1].map(async (index) => (await env.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: `note zorpWord${index}`, runId: saver.id, step: 1, callId: `save_${index}` })).memory.id));
    expect((await env.store.transition(saverClaim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    env.clock.advance(1);
    const run = env.enqueue('Work through it', { history: 'fresh' });
    const claim = await env.seed(run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'manual' }, { type: 'context.memories_loaded', memories: memoryIds.map((id) => ({ id, status: 'unbound' as const })) }, responded('the answer mentions zorpWord1 only')], 'hold');
    const inProcess = await journalReaderPreparer(env.dbPath).measure({ runId: run.id, leading: [] });

    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    await thread.close();

    const [recorded] = env.ofType(run.id, 'context.contribution');
    expect(recorded?.items).toEqual(inProcess.contribution?.items);
    expect(recorded?.items.filter((item) => item.contributed).map((item) => item.id)).toEqual([memoryIds[1]]);
  });

  it('rejects a request without a run id as a request error of the thread and keeps serving', async () => {
    let dbPath = '';
    const thread = throughTheThread(() => dbPath);
    const env = await makeEnv({ preparer: thread.preparer });
    dbPath = env.dbPath;
    const { dev, ino } = fs.statSync(dbPath);
    const client = await startJournalThread({ lock: testKernelLock(), databasePath: dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });

    await expect(client.request({ kind: 'contribution', leading: [] })).rejects.toBeInstanceOf(JournalThreadError);
    expect(await client.ping()).toMatchObject({ threadId: expect.any(Number) });

    await client.close();
    await thread.close();
  });
});
