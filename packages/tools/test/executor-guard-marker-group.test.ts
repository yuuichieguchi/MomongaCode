import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { keyFor } from './helpers.ts';
import { LEAVER_PGID, markerOf, resultOf, runOne, world } from './guard-world.ts';

type MarkerGroupApi = {
  recordMarkerGroup(marker: string, pgid: number): Promise<void>;
  readMarkerGroup(marker: string): Promise<number | undefined>;
};

const markerGroups = foundation as unknown as MarkerGroupApi;

const STILL_RUNNING = 'may still be running and could not be stopped.';
const COULD_NOT_CHECK = (name: string, reason: string) =>
  `Note: MomongaCode could not check whether a process started by an earlier command (marker ${name}) is still running (${reason}). The command ran. It will check again before the next command that runs a process or changes files in this session.`;

const CALL_KEY = keyFor('run-0', 1, 'earlier');

describe.each([`hook-${'b'.repeat(32)}`, `evidence-${'c'.repeat(32)}`, `${CALL_KEY}-1`])('the guard reads the process group of a %s marker from the marker file', (name) => {
  it('refuses with the still-running wording when the marker is held, nobody is named and a member of the recorded group can still run', async () => {
    const h = world('held', {}, new Set([LEAVER_PGID]));
    const marker = path.join(h.harness.markerDir, name);
    fs.writeFileSync(marker, '', { mode: 0o600 });
    await markerGroups.recordMarkerGroup(marker, LEAVER_PGID);
    const refused = resultOf(await runOne(h, 'Writer', 'next'));
    expect(refused.status).toBe('failed');
    expect(refused.output).toContain(`(marker ${name}, unidentified) ${STILL_RUNNING}`);
    expect(refused.output).not.toContain('could not check');
    expect(h.askedGroups).toContain(LEAVER_PGID);
  });
});

describe('the marker file is the one source of the group of a call marker', () => {
  it('writes the attached group into the call marker file', async () => {
    const h = world('held', {}, new Set([LEAVER_PGID]));
    await runOne(h, 'Leaver', 'first');
    expect(await markerGroups.readMarkerGroup(markerOf(h, 'first'))).toBe(LEAVER_PGID);
  });

  it('answers could not check, not the ledger group, when the ledger row has a group and the marker file has none', async () => {
    const h = world('held', {}, new Set([LEAVER_PGID]));
    await runOne(h, 'Leaver', 'first');
    const name = keyFor('run-1', 1, 'first');
    fs.writeFileSync(markerOf(h, 'first'), '');
    expect(resultOf(await runOne(h, 'Writer', 'second'))).toEqual({ status: 'completed', output: `wrote\n${COULD_NOT_CHECK(name, 'no process group is recorded for the marker')}` });
    expect(h.askedGroups).not.toContain(LEAVER_PGID);
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(true);
  });
});
