import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createUdsClient, fixedRolePort, fixedSocket } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, forEachSeed, seedsFrom } from '@momonga/testkit';
import type { UdsClient } from '@momonga/foundation';
import { onCleanup } from '../process/helpers.ts';
import { launchService, openEventStream, serviceOptions, startService } from '../service/helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS * 4 });

const RUNS = 200;
const FIRST_SEED = 4_301;
const MAX_NOTICES = 200;

const delivered = async (client: UdsClient, runId: string, lastEventId: number | undefined, count: number | 'to-last', last: number): Promise<number[]> => {
  const stream = await openEventStream(client, `/v1/runs/${runId}/events`, lastEventId === undefined ? {} : { headers: { 'last-event-id': String(lastEventId) } });
  try {
    let seen = 0;
    const events = await stream.until((event) => {
      seen += 1;
      return count === 'to-last' ? event.seq === last : seen === count;
    });
    return events.map((event) => Number(event.seq));
  } finally {
    stream.close();
  }
};

const PLANTED_SEEDS = 20;

const moveWorld = async () => {
  const env = await startService();
  const retiringSocket = path.join(path.dirname(env.layout.socketPath), 'retiring.sock');
  const retiring = await launchService(
    serviceOptions({ store: env.store, clock: env.clock, home: env.layout.home, socketPath: retiringSocket, ports: env.ports, notifier: env.notifier, errors: env.errors }, { role: fixedRolePort('retiring') }),
  );
  const retiringClient = createUdsClient(fixedSocket(retiringSocket), { connectTimeoutMs: 0 });
  onCleanup(async () => {
    await retiringClient.close();
    await retiring.close();
  });
  const property = (seeds: readonly number[], resumeShift: number): Promise<void> =>
    forEachSeed('output across a move', seeds, async (generator) => {
      const session = await env.createSession();
      const run = await env.createRun(session.id);
      env.append(env.claimRun(run.id), env.notices(1 + generator.below(MAX_NOTICES)));
      const stored = env.runEvents(run.id).map((event) => event.seq);
      const last = stored[stored.length - 1];
      if (last === undefined) throw new Error(`run ${run.id} stored no event`);
      const cut = 1 + generator.below(stored.length);
      const before = await delivered(retiringClient, run.id, undefined, cut, last);
      const resumeAfter = (before[before.length - 1] ?? 0) - resumeShift;
      const after = cut === stored.length && resumeShift === 0 ? [] : await delivered(env.client, run.id, resumeAfter, 'to-last', last);
      expect([...before, ...after]).toEqual(stored);
    });
  return { property };
};

describe('T-I4-30 (section 5 I13, rule 3b): output delivered across a move is neither lost nor duplicated', () => {
  it(`delivers, over ${RUNS} generated runs of 1 to ${MAX_NOTICES} events cut after any event, the stored sequence once when the client resumes with Last-Event-ID on the other generation`, async () => {
    const { property } = await moveWorld();
    await property(seedsFrom(FIRST_SEED, RUNS), 0);
  });

  it('fails, naming its seed, on a planted violation: a resume one event early delivers that event twice', async () => {
    const { property } = await moveWorld();
    await expect(property(seedsFrom(FIRST_SEED, PLANTED_SEEDS), 1)).rejects.toThrow(String(FIRST_SEED));
  });
});
