import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElicitationRequestView, PermissionOption, RunEventPayload } from '@momonga/protocol';
import { openRuntimeStore } from '@momonga/store';
import type { Claim, Run, RuntimeStore } from '@momonga/store';
import { createFakeClock, testKernelLock } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { UNASKED_COMMANDS } from '../helpers.ts';
import { BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';

export const CONTRACT_START_MS = 1_900_000_000_000;
const LEASE_MS = 1000;
const TIMEOUT_MS = 3_600_000;
export const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
export const REQUESTS: ElicitationRequestView[] = [{ key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }];

export type ContractStore = { store: RuntimeStore; clock: FakeClock; dbPath: string; close(): void };

export const openContractStore = (dbPath: string, clock: FakeClock = createFakeClock(CONTRACT_START_MS)): ContractStore => {
  const store = openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), unaskedCommands: UNASKED_COMMANDS, path: dbPath, home: path.dirname(dbPath), clock, leaseMs: LEASE_MS, maxAttempts: 5, maxTotalAttempts: 1000 });
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

export const call = (callId: string): RunEventPayload => ({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: callId, rawInput: { file_path: `/work/contract/${callId}.txt` }, locations: [{ path: `/work/contract/${callId}.txt` }] });

export const enqueue = (store: RuntimeStore, sessionId: string, input: string): Run => {
  const result = store.createRunAndEnqueue(sessionId, { input, timeoutMs: TIMEOUT_MS, limits: { maxSteps: 10 }, pins: { model: 'fm' } });
  if (result.kind !== 'created') throw new Error(`expected a run, got ${result.kind}`);
  return result.run;
};

export const claimOf = (store: RuntimeStore, runId: string, workerId: string): Claim => {
  const claim = store.claim(workerId);
  if (claim === null || claim.runId !== runId) throw new Error(`expected ${workerId} to claim run ${runId}`);
  return claim;
};

export const ok = <T extends { kind: string }>(result: T, label: string): Extract<T, { kind: 'ok' }> => {
  if (result.kind !== 'ok') throw new Error(`${label}: expected ok, got ${result.kind}`);
  return result as Extract<T, { kind: 'ok' }>;
};

export const writeContractRows = async (store: RuntimeStore, tag: string): Promise<void> => {
  const session = store.createSession({ cwd: '/work/contract', env: { PATH: '/usr/bin' }, permissionMode: 'manual', model: 'fm' });
  const run = enqueue(store, session.id, `written by ${tag}`);
  const claim = claimOf(store, run.id, `writer-${tag}`);
  ok(store.append(claim, [call(`${tag}-c1`), { type: 'notice', level: 'info', message: `written by ${tag}`, code: 'contract.writer' }]), 'append');
  ok(await store.release(claim, 'COMPLETED'), 'release');
};

export const buildCompatTemplate = async (file: string, tag: string): Promise<void> => {
  const contract = openContractStore(file);
  try {
    await writeContractRows(contract.store, tag);
  } finally {
    contract.close();
  }
};
