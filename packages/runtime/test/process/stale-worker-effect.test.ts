import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testKernelLock } from '@momonga/testkit';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { createSeatbeltSandbox } from '@momonga/sandbox';
import { HAS_SEATBELT, createRun, createSession, fenceFor, makeRuntimeFixture, makeTempHome, runBashThroughPort, writeUserSettings } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LEASE_EXPIRY_MS = 30_001;
const CALL_ID = 'call-1';

const takeOver = async () => {
  const temp = await makeTempHome();
  const f = await makeRuntimeFixture({ temp, sandbox: createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot: temp.paths.tmp.spawn, killGraceMs: 300 }) });
  writeUserSettings(temp.home, {});
  const session = createSession(f.store, temp.project, { env: { PATH: '/usr/bin:/bin' } });
  const runId = await createRun(f.store, session.id);
  const stale = fenceFor(f.store, runId, 'w1');
  f.clock.advance(LEASE_EXPIRY_MS);
  const claim = f.store.claim('w2');
  if (claim === null || claim.runId !== runId) throw new Error('w2 could not take the run over');
  const fresh = { runId, workerId: 'w2', leaseToken: claim.leaseToken };
  const key = sha256Hex(canonicalJson([runId, 1, CALL_ID]));
  const effect = path.join(temp.project, 'effect-ran');
  const bash = (fence: typeof stale) => runBashThroughPort(f, session, runId, `touch '${effect}'`, 'bypassPermissions', { fence, callId: CALL_ID });
  return { f, stale, fresh, key, effect, bash };
};

describe.runIf(HAS_SEATBELT)('a worker whose lease was taken over, with a real Bash tool', () => {
  it('starts no process when it reaches the first ledger write', async () => {
    const { f, stale, fresh, key, effect, bash } = await takeOver();
    expect(stale.leaseToken).toBeLessThan(fresh.leaseToken);

    const superseded = await bash(stale);

    expect(superseded.outcome).toEqual({ callId: CALL_ID, kind: 'deferred' });
    expect(fs.existsSync(effect)).toBe(false);
    expect(f.store.idempotency.get(key)).toBeUndefined();

    const holder = await bash(fresh);

    expect(holder.outcome.kind).toBe('result');
    expect(fs.existsSync(effect)).toBe(true);
    expect(f.store.idempotency.get(key)).toMatchObject({ s: 'COMPLETED' });
  });

  it('starts no process when it resumes a record that the current holder created', async () => {
    const { f, stale, fresh, key, effect, bash } = await takeOver();
    expect(f.store.idempotency.holding(fresh).begin(key, { expiresAt: f.clock.now() + 60_000, meta: { tool: 'Bash' } })).toEqual({ s: 'NEW' });

    const superseded = await bash(stale);

    expect(superseded.outcome).toEqual({ callId: CALL_ID, kind: 'deferred' });
    expect(fs.existsSync(effect)).toBe(false);
    expect(f.store.idempotency.get(key)).toMatchObject({ s: 'PENDING', rec: { leaseToken: fresh.leaseToken } });
  });
});
