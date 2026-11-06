import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import type { ElicitationRequestView, PermissionOption, RunEventPayload } from '@momonga/protocol';
import { openRuntimeStore } from '@momonga/store';
import type { Claim, Run, RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';

export const CONTRACT_START_MS = 1_900_000_000_000;
const LEASE_MS = 1000;
const TIMEOUT_MS = 3_600_000;
const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
const REQUESTS: ElicitationRequestView[] = [{ key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }];

export type ContractStore = { store: RuntimeStore; clock: FakeClock; dbPath: string; close(): void };

export const openContractStore = (dbPath: string, clock: FakeClock = createFakeClock(CONTRACT_START_MS)): ContractStore => {
  const store = openRuntimeStore({ path: dbPath, home: path.dirname(dbPath), clock, leaseMs: LEASE_MS, maxAttempts: 5, maxTotalAttempts: 1000 });
  return { store, clock, dbPath, close: () => store.close() };
};

export const copyTemplate = (template: string): { dbPath: string; remove(): void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-compat-'));
  fs.chmodSync(dir, 0o700);
  const dbPath = path.join(dir, 'runtime.db');
  fs.copyFileSync(template, dbPath);
  fs.chmodSync(dbPath, 0o600);
  return { dbPath, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const call = (callId: string): RunEventPayload => ({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: callId, rawInput: { file_path: `/work/contract/${callId}.txt` }, locations: [{ path: `/work/contract/${callId}.txt` }] });

const enqueue = (store: RuntimeStore, sessionId: string, input: string): Run => {
  const result = store.createRunAndEnqueue(sessionId, { input, timeoutMs: TIMEOUT_MS, limits: { maxSteps: 10 }, pins: { model: 'fm' } });
  if (result.kind !== 'created') throw new Error(`expected a run, got ${result.kind}`);
  return result.run;
};

const claimOf = (store: RuntimeStore, runId: string, workerId: string): Claim => {
  const claim = store.claim(workerId);
  if (claim === null || claim.runId !== runId) throw new Error(`expected ${workerId} to claim run ${runId}`);
  return claim;
};

const ok = <T extends { kind: string }>(result: T, label: string): T => {
  if (result.kind !== 'ok') throw new Error(`${label}: expected ok, got ${result.kind}`);
  return result;
};

export const writeContractRows = (store: RuntimeStore, tag: string): void => {
  const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'default', modelAlias: 'fm' });
  const run = enqueue(store, session.id, `written by ${tag}`);
  const claim = claimOf(store, run.id, `writer-${tag}`);
  ok(store.append(claim, [call(`${tag}-c1`), { type: 'notice', level: 'info', message: `written by ${tag}`, code: 'contract.writer' }]), 'append');
  ok(store.release(claim, 'COMPLETED'), 'release');
};

export type ContractOperation = { name: string; run(contract: ContractStore): Promise<void> | void };

export const CONTRACT_OPERATIONS: readonly ContractOperation[] = [
  {
    name: 'lists the sessions and reads the runs and events the newer build wrote',
    run: ({ store }) => {
      for (const session of store.listSessions()) {
        for (const run of store.listRuns(session.id)) {
          store.load(run.id);
          store.readRunEvents(run.id, 0, 10_000);
          store.finalTextOf(run.id);
          store.startedCallsOf(run.id);
        }
        store.readSessionEvents(session.id, 0, 10_000);
      }
    },
  },
  {
    name: 'creates a session and a run, claims it, appends, releases it, claims it again and completes it',
    run: async ({ store }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'default', modelAlias: 'fm' });
      const run = enqueue(store, session.id, 'contract run');
      const claim = claimOf(store, run.id, 'contract-worker');
      ok(store.append(claim, [{ type: 'notice', level: 'info', message: 'contract' }]), 'append');
      ok(store.heartbeat(claim), 'heartbeat');
      ok(store.release(claim, 'QUEUED'), 'release');
      const again = claimOf(store, run.id, 'contract-worker');
      ok(await store.transition(again, ['RUNNING'], 'COMPLETED'), 'transition');
      expect(store.getRun(run.id)?.status).toBe('COMPLETED');
    },
  },
  {
    name: 'cancels a queued run',
    run: ({ store }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'default', modelAlias: 'fm' });
      const run = enqueue(store, session.id, 'to cancel');
      expect(store.requestCancel(run.id).kind).toBe('ok');
    },
  },
  {
    name: 'requests and resolves an approval and an elicitation',
    run: async ({ store, clock }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'default', modelAlias: 'fm' });
      const run = enqueue(store, session.id, 'asks');
      const claim = claimOf(store, run.id, 'asking-worker');
      ok(store.append(claim, [call('ask-1'), call('ask-2')]), 'append calls');
      const expiresAt = clock.now() + 60_000;
      const approval = ok(store.requestApproval(claim, { callId: 'ask-1', options: OPTIONS, expiresAt, event: { subjectDigest: 'a'.repeat(64), reason: 'contract' } }), 'approval').approval;
      const elicitation = ok(store.requestElicitation(claim, { callId: 'ask-2', expiresAt, server: 'remote', requests: REQUESTS }), 'elicitation').approval;
      ok(store.release(claim, 'WAITING_HUMAN'), 'park');
      expect((await store.resolveApproval(approval.id, 'allow_once')).kind).toBe('ok');
      expect((await store.resolveElicitation(elicitation.id, { who: { action: 'accept', content: { name: 'contract' } } })).kind).toBe('ok');
    },
  },
  {
    name: 'starts and finishes a background job',
    run: ({ store }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'default', modelAlias: 'fm' });
      const run = enqueue(store, session.id, 'job');
      claimOf(store, run.id, 'job-worker');
      const started = store.jobs.start({ id: 'bash_contract0001', idemKey: 'bash_contract0001-key', sessionId: session.id, runId: run.id, callId: 'call-1', command: 'sleep 1' });
      expect(store.jobs.finish(started.job.id, { status: 'killed' }).kind).toBe('finished');
    },
  },
  {
    name: 'saves and lists a memory, searches the history and records fidelity verdicts',
    run: ({ store }) => {
      const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'default', modelAlias: 'fm' });
      const run = enqueue(store, session.id, 'contractneedle');
      const claim = claimOf(store, run.id, 'memory-worker');
      ok(store.append(claim, [call('mem-1')]), 'append');
      store.memories.save({ origin: 'trusted', scope: 'project', project: '/work/contract', text: 'contract memory', runId: run.id, step: claim.step ?? 0, callId: 'mem-1' });
      expect(store.memories.list().length).toBeGreaterThan(0);
      store.search.query({ trusted: true, project: '/work/contract' }, { query: 'contractneedle', scope: 'project' });
      store.recordFidelityVerdicts(run.id, '/work/contract', { checkedThrough: 1, verdicts: [{ token: 'make', inh: 'none', inhDeps: [], taskStated: false, statedAt: null, executedAt: null, ownDeps: [] }] });
    },
  },
];

export const buildCompatTemplate = (file: string, tag: string): void => {
  const contract = openContractStore(file);
  try {
    writeContractRows(contract.store, tag);
  } finally {
    contract.close();
  }
};
