import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KEEPER_JOB_PREFIX, createKeptGroupControl, createProcessGroupPort, nodeCommandRunner } from '@momonga/foundation';
import type { ProcessInspector } from '@momonga/foundation';
import { createMarkerSettle } from '../src/marker-settle.ts';
import { answeringMembers, fakeKeeperHost } from '../../foundation/test/support/fake-keeper.ts';

const NAME = 'd7'.repeat(16);
const PGID = 5150;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const markerHolding = (text: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-settle-name-'));
  dirs.push(dir);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, text, { mode: 0o600 });
  return marker;
};

const unusedInspector = {} as ProcessInspector;

describe('the liveness of a group another process recorded is asked by the name in its marker', () => {
  it('recalls the job name from the marker before it asks the port', async () => {
    const fake = fakeKeeperHost((keeper) => {
      answeringMembers(() => [77])(keeper);
      keeper.say('attached\n');
    });
    const groupPort = createProcessGroupPort('win32', { run: nodeCommandRunner, env: {}, kept: createKeptGroupControl(fake.host) });
    const marker = markerHolding(`r00000\ng${String(PGID).padStart(10, '0')}\nj${NAME}\n`);
    const settle = createMarkerSettle({ marker, mode: 'listed', inspector: unusedInspector, groupPort, onWarning: () => undefined });
    expect(await settle.groupAlive(PGID, new AbortController().signal)).toBe(true);
    expect(fake.keepers[0]?.args).toEqual(['attach', fake.listened[0], `${KEEPER_JOB_PREFIX}${NAME}`]);
  });

  it('answers by the rule of the port when the marker names no job', async () => {
    const groupPort = createProcessGroupPort('win32', { run: nodeCommandRunner, env: {}, kept: createKeptGroupControl(fakeKeeperHost().host) });
    const marker = markerHolding(`r00000\ng${String(PGID).padStart(10, '0')}\n`);
    const settle = createMarkerSettle({ marker, mode: 'listed', inspector: unusedInspector, groupPort, onWarning: () => undefined });
    await expect(settle.groupAlive(PGID, new AbortController().signal)).rejects.toThrow(`no job is recorded for process group ${PGID}`);
  });
});
