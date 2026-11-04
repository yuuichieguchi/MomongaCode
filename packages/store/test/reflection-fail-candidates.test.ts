import { describe, expect, it } from 'vitest';
import type { ContextChargeInput, SaveCandidateInput } from '@momonga/store';
import { enqueue, harness, newSession, rawDb } from './helpers.ts';

type Job = { state: string; lastError: string | null };

type Failing = {
  enqueue(runId: string): boolean;
  begin(runId: string): Job;
  finish(runId: string, reason?: string): Job;
  get(runId: string): Job | undefined;
  fail(runId: string, reason: string, charge?: ContextChargeInput, candidates?: readonly SaveCandidateInput[]): Job;
};

const PROJECT = '/work/a';

const charge = (runId: string): ContextChargeInput =>
  ({ purpose: 'reflection', runId, project: PROJECT, model: 'fm', inputTokens: 10, outputTokens: 5, totalTokens: 15 }) as ContextChargeInput;

const fact = (runId: string, ordinal: number, command: string): SaveCandidateInput => ({
  scope: 'project',
  origin: 'trusted',
  project: PROJECT,
  text: `Run \`${command}\` to verify a change in this repository.`,
  runId,
  ordinal,
  kind: 'procedure',
  evidence: [{ kind: 'check', runId, callId: `t${ordinal}`, seq: 4 + ordinal, command, exitCode: 0 }],
});

const started = () => {
  const { store, dbPath } = harness();
  const session = newSession(store, PROJECT);
  const run = enqueue(store, session.id, 'fix the bug');
  const jobs = store.reflection as unknown as Failing;
  jobs.enqueue(run.id);
  jobs.begin(run.id);
  return { store, dbPath, run, jobs };
};

describe('a failed reflection job keeps the candidates code produced', () => {
  it('stores the given candidates, records the charge and fails the job in one commit', () => {
    const { store, run, jobs } = started();
    const failed = jobs.fail(run.id, 'the call failed', charge(run.id), [fact(run.id, 0, 'npm test'), fact(run.id, 1, 'npm run lint')]);
    expect(failed).toMatchObject({ state: 'failed', lastError: 'the call failed' });
    expect(store.contextCharges.list()).toHaveLength(1);
    const saved = store.memories.candidates();
    expect(saved.map((memory) => [memory.text, memory.kind, memory.state, memory.source])).toEqual([
      ['Run `npm test` to verify a change in this repository.', 'procedure', 'candidate', { kind: 'reflection', sessionId: expect.any(String), runId: run.id, ordinal: 0 }],
      ['Run `npm run lint` to verify a change in this repository.', 'procedure', 'candidate', { kind: 'reflection', sessionId: expect.any(String), runId: run.id, ordinal: 1 }],
    ]);
    expect(saved[0]?.evidence).toEqual([{ kind: 'check', runId: run.id, callId: 't0', seq: 4, command: 'npm test', exitCode: 0 }]);
  });

  it('stores the candidates of a failure that made no model charge', () => {
    const { store, run, jobs } = started();
    jobs.fail(run.id, 'the call failed', undefined, [fact(run.id, 0, 'npm test')]);
    expect(store.contextCharges.list()).toEqual([]);
    expect(store.memories.candidates().map((memory) => memory.text)).toEqual(['Run `npm test` to verify a change in this repository.']);
  });

  it('stores no candidate when the job is not running, so a settled job gains nothing', () => {
    const { store, run, jobs } = started();
    jobs.finish(run.id, 'finished elsewhere');
    expect(() => jobs.fail(run.id, 'late', charge(run.id), [fact(run.id, 0, 'npm test')])).toThrow('cannot fail');
    expect(store.memories.candidates()).toEqual([]);
    expect(store.contextCharges.list()).toEqual([]);
  });

  it('commits nothing when a candidate cannot be stored: no charge, no candidate, the job still running', () => {
    const { store, dbPath, run, jobs } = started();
    rawDb(dbPath).exec("CREATE TRIGGER fail_memories BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect(() => jobs.fail(run.id, 'the call failed', charge(run.id), [fact(run.id, 0, 'npm test')])).toThrow('injected failure');
    expect(store.contextCharges.list()).toEqual([]);
    expect(store.memories.candidates()).toEqual([]);
    expect(jobs.get(run.id)).toMatchObject({ state: 'running' });
  });
});
