import { fixedRolePort } from '@momonga/foundation';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeTimers } from '@momonga/testkit';
import type { Claim, Run } from '@momonga/store';
import { startClaimControl } from '../../src/worker/claim-control.ts';
import { openJournal } from '../../src/worker/journal.ts';
import { createTerminals } from '../../src/worker/terminals.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';

const specPath = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'specs', 'tla', 'RunRecovery.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const whenCancelling = (): { finish: string; yield: string } => {
  const match = /^WhenCancelling == \[finish \|-> "([A-Z_]+)", yield \|-> "([A-Z_]+)"\]/m.exec(spec);
  if (match === null) throw new Error(`WhenCancelling is not defined in ${specPath}`);
  return { finish: match[1] as string, yield: match[2] as string };
};

const outcomeOf = (run: Run): string => {
  if (run.status === 'CANCELLED') return 'CANCELLED';
  if (run.status === 'CANCELLING' && run.leaseOwner === null) return 'RELEASED';
  return `${run.status} owned by ${String(run.leaseOwner)}`;
};

const cancellingRun = async (): Promise<{ env: Env; claim: Claim; leave: ReturnType<typeof createTerminals> }> => {
  const env = await makeEnv();
  const run = env.enqueue();
  const claim = env.store.claim('w1');
  if (claim === null) throw new Error('the run could not be claimed');
  await env.store.requestCancel(run.id);
  expect(env.run(run.id).status).toBe('CANCELLING');
  const control = startClaimControl({ store: env.store, timers: createFakeTimers(env.clock), claim, role: fixedRolePort('serving'), heartbeatMs: 1000, cancelPollMs: 1000 });
  const journal = openJournal({ store: env.store, claim, lost: control.lost });
  return { env, claim, leave: createTerminals({ store: env.store, claim, journal, control, clock: env.clock }) };
};

describe('what a worker leaving a CANCELLING run does, against RunRecovery.tla WhenCancelling', () => {
  it.each(['COMPLETED', 'STOPPED', 'FAILED'] as const)('finish(%s) ends the run as the spec says', async (to) => {
    const { env, claim, leave } = await cancellingRun();
    await leave.finish(to);
    expect(outcomeOf(env.run(claim.runId))).toBe(whenCancelling().finish);
  });

  it.each(['WAITING_HUMAN', 'WAITING_TOOL', 'QUEUED'] as const)('yieldTo(%s) leaves the run as the spec says, and the next claim runs cancel recovery', async (to) => {
    const { env, claim, leave } = await cancellingRun();
    const attemptsBefore = env.run(claim.runId).attempts;
    await leave.yieldTo(to);
    const run = env.run(claim.runId);
    expect(outcomeOf(run)).toBe(whenCancelling().yield);
    expect(run.attempts).toBe(attemptsBefore - 1);
    expect(run.failedAttempts).toBe(0);
    expect(env.store.claim('w2')).toMatchObject({ runId: claim.runId, status: 'CANCELLING' });
  });

  it('names exactly the two ways a worker leaves', async () => {
    expect(Object.keys(whenCancelling()).sort()).toEqual(['finish', 'yield']);
  });

  it('models exactly the terminals a worker has', async () => {
    const { leave } = await cancellingRun();
    const listed = /^TerminalMethods == \{([^}]*)\}/m.exec(spec);
    if (listed === null) throw new Error(`TerminalMethods is not defined in ${specPath}`);
    const modelled = [...(listed[1] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(modelled.sort()).toEqual(Object.keys(leave).sort());
  });
});
