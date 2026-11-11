import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usageOf } from '@momonga/testkit';
import { contributionAtTerminal } from '@momonga/runtime';
import type { ScriptStep } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const WINDOW = 8192;
const TASK = `Echo something ${'padding '.repeat(500)}`;

type Measurement = { runId: string; underWriteLock: boolean };

const probes: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of probes.splice(0)) db.close();
});

const writeLockProbe = (dbPath: string): (() => boolean) => {
  const db = new DatabaseSync(dbPath);
  probes.push(db);
  db.exec('PRAGMA busy_timeout = 0');
  return () => {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (error instanceof Error && /locked|busy/i.test(error.message)) return true;
      throw error;
    }
    db.exec('ROLLBACK');
    return false;
  };
};

const runMeasured = async (step: ScriptStep): Promise<{ runId: string; status: string; errorCode: string | undefined; measurements: Measurement[] }> => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW, { maxOutputTokens: 1024 }) });
  const underWriteLock = writeLockProbe(env.dbPath);
  const measure = contributionAtTerminal.measure;
  const measurements: Measurement[] = [];
  vi.spyOn(contributionAtTerminal, 'measure').mockImplementation((input) => {
    measurements.push({ runId: input.run.id, underWriteLock: underWriteLock() });
    return measure(input);
  });
  env.gateway.script.push(step);
  const run = await env.enqueue(TASK);

  await env.runOnce(env.worker());

  const finished = env.run(run.id);
  return { runId: run.id, status: finished.status, errorCode: finished.error?.code, measurements };
};

describe('the product contribution hook at a terminal reached through the model step', () => {
  it('measures a run that fails on a truncated input exactly once, never while the write transaction is open', async () => {
    const { runId, status, errorCode, measurements } = await runMeasured(textStep('Done.', { usage: usageOf(10, 5) }));

    expect(status).toBe('FAILED');
    expect(errorCode).toBe('input_truncated');
    expect(measurements).toEqual([{ runId, underWriteLock: false }]);
  });

  it('measures a run that completes exactly once, never while the write transaction is open', async () => {
    const { runId, status, measurements } = await runMeasured(textStep('Done.'));

    expect(status).toBe('COMPLETED');
    expect(measurements).toEqual([{ runId, underWriteLock: false }]);
  });
});
