import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdempotencyLookup, IdempotencyRecord, Run } from '@momonga/store';
import { withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';

const START_MS = 1_800_000_000_000;
const KILL_GRACE_MS = 2000;
const KEY = '0'.repeat(64);
const PGID = 424242;

const trackedMarkerDir = (context: CleanupContext): string => {
  const dir = path.join(withTempDir(context), 'tools');
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
};

const emptyMarker = (dir: string, name: string): string => {
  const marker = path.join(dir, name);
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

const terminalWarningFor = (marker: string, runId: string): string => `tool marker ${marker}: run ${runId} is terminal, so its holder was reaped`;

const pendingDeadLettered = (): { store: { idempotency: { get(key: string): IdempotencyLookup | undefined }; getRun(id: string): Pick<Run, 'id' | 'status' | 'deadLetter'> | undefined } } => {
  const rec: IdempotencyRecord = { key: KEY, state: 'PENDING', meta: { runId: 'run-dead' }, pgid: PGID, createdAt: START_MS, expiresAt: START_MS + 86_400_000 };
  const lookup: IdempotencyLookup = { s: 'PENDING', rec } as IdempotencyLookup;
  return {
    store: {
      idempotency: { get: (key: string) => (key === KEY ? lookup : undefined) },
      getRun: (id: string) => (id === 'run-dead' ? { id: 'run-dead', status: 'FAILED', deadLetter: true } : undefined),
    },
  };
};

describe('terminal-run warning is written only after the reap settles fulfilled (B2)', () => {
  it('a rejected reap does not log the "holder was reaped" warning for that marker', async (context) => {
    const dir = trackedMarkerDir(context);
    const marker = emptyMarker(dir, KEY);
    const { store } = pendingDeadLettered();
    const warnings: string[] = [];
    await reapToolMarkers({
      dir,
      store: store as never,
      killGraceMs: KILL_GRACE_MS,
      onWarning: (message) => void warnings.push(message),
      reap: (async () => {
        throw new Error('reap exploded');
      }) as never,
      scope: { deadLetterOnly: true, skipKeys: new Set() },
    });
    expect(warnings).not.toContain(terminalWarningFor(marker, 'run-dead'));
    expect(warnings.some((message) => message.includes('could not be reaped'))).toBe(true);
  });

  it('a fulfilled reap logs the "holder was reaped" warning', async (context) => {
    const dir = trackedMarkerDir(context);
    const marker = emptyMarker(dir, KEY);
    const { store } = pendingDeadLettered();
    const warnings: string[] = [];
    await reapToolMarkers({
      dir,
      store: store as never,
      killGraceMs: KILL_GRACE_MS,
      onWarning: (message) => void warnings.push(message),
      reap: (async () => ({ removed: true })) as never,
      scope: { deadLetterOnly: true, skipKeys: new Set() },
    });
    expect(warnings).toContain(terminalWarningFor(marker, 'run-dead'));
  });
});
