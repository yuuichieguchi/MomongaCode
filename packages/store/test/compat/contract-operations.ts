import { expect } from 'vitest';
import { OPTIONS, REQUESTS, call, claimOf, enqueue, ok } from './contract-writer.ts';
import type { ContractStore } from './contract-writer.ts';

export { buildCompatTemplate, copyTemplate, openContractStore, writeContractRows } from './contract-writer.ts';
export type { ContractStore } from './contract-writer.ts';

export type ContractOperation = { name: string; run(contract: ContractStore): Promise<void> | void };

export const CONTRACT_OPERATIONS: readonly ContractOperation[] = [
  {
    name: 'lists the sessions and reads the runs and events the newer build wrote',
    run: async ({ store }) => {
      for (const session of store.listSessions()) {
        for (const run of store.listRuns(session.id)) {
          store.load(run.id);
          store.readRunEvents(run.id, 0, 10_000);
          await store.finalTextOf(run.id);
          await store.startedCallsOf(run.id);
        }
        store.readSessionEvents(session.id, 0, 10_000);
      }
    },
  },
  {
    name: 'creates a session and a run, claims it, appends, releases it, claims it again and completes it',
    run: async ({ store }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'manual', model: 'fm' });
      const run = enqueue(store, session.id, 'contract run');
      const claim = claimOf(store, run.id, 'contract-worker');
      ok(store.append(claim, [{ type: 'notice', level: 'info', message: 'contract' }]), 'append');
      ok(store.heartbeat(claim), 'heartbeat');
      ok(await store.release(claim, 'QUEUED'), 'release');
      const again = claimOf(store, run.id, 'contract-worker');
      ok(await store.transition(again, ['RUNNING'], 'COMPLETED'), 'transition');
      expect(store.getRun(run.id)?.status).toBe('COMPLETED');
    },
  },
  {
    name: 'cancels a queued run',
    run: async ({ store }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'manual', model: 'fm' });
      const run = enqueue(store, session.id, 'to cancel');
      expect((await store.requestCancel(run.id)).kind).toBe('ok');
    },
  },
  {
    name: 'requests and resolves an approval and an elicitation',
    run: async ({ store, clock }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'manual', model: 'fm' });
      const run = enqueue(store, session.id, 'asks');
      const claim = claimOf(store, run.id, 'asking-worker');
      ok(store.append(claim, [call('ask-1'), call('ask-2')]), 'append calls');
      const expiresAt = clock.now() + 60_000;
      const approval = ok(await store.requestApproval(claim, { callId: 'ask-1', options: OPTIONS, event: { subjectDigest: 'a'.repeat(64), reason: 'contract' } }), 'approval').approval;
      const elicitation = ok(await store.requestElicitation(claim, { callId: 'ask-2', expiresAt, server: 'remote', requests: REQUESTS }), 'elicitation').approval;
      ok(await store.release(claim, 'WAITING_HUMAN'), 'park');
      expect((await store.resolveApproval(approval.id, 'allow_once')).kind).toBe('ok');
      expect((await store.resolveElicitation(elicitation.id, { who: { action: 'accept', content: { name: 'contract' } } })).kind).toBe('ok');
    },
  },
  {
    name: 'starts and finishes a background job',
    run: async ({ store }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'manual', model: 'fm' });
      const run = enqueue(store, session.id, 'job');
      claimOf(store, run.id, 'job-worker');
      const started = store.jobs.start({ id: 'bash_contract0001', idemKey: 'bash_contract0001-key', sessionId: session.id, runId: run.id, callId: 'call-1', command: 'sleep 1' });
      expect(store.jobs.finish(started.job.id, { status: 'killed' }).kind).toBe('finished');
    },
  },
  {
    name: 'saves and lists a memory, searches the history and records fidelity verdicts',
    run: async ({ store }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'manual', model: 'fm' });
      const run = enqueue(store, session.id, 'contractneedle');
      const claim = claimOf(store, run.id, 'memory-worker');
      ok(store.append(claim, [call('mem-1')]), 'append');
      await store.memories.save({ origin: 'trusted', scope: 'project', project: '/work/contract', text: 'contract memory', runId: run.id, step: 1, callId: 'mem-1' });
      expect(store.memories.list().length).toBeGreaterThan(0);
      store.search.query({ trusted: true, project: '/work/contract' }, { query: 'contractneedle', scope: 'project' });
      store.recordFidelityVerdicts(run.id, '/work/contract', { checkedThrough: 1, verdicts: [{ token: 'make', inh: 'none', inhDeps: [], taskStated: false, statedAt: null, executedAt: null, ownDeps: [] }] });
    },
  },
];

