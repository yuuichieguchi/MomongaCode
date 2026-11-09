import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keyFor } from './helpers.ts';
import { LEAVER_PGID, markerOf, resultOf, runOne, world } from './guard-world.ts';

const SETTLED_PREFIX = (name: string) => `Not run: a process started by an earlier command (marker ${name}, unidentified) may still be running and could not be stopped. `;
const FINAL_NOTICE_END = (name: string) =>
  `MomongaCode has used its four retries and will not try again. Stop it and retry. If it can stay running, ask the person to run /markers ignore ${name}.`;
const HELD_FINAL_NOTICE = (name: string) =>
  `Note: a process started by an earlier command (marker ${name}) may still be running. MomongaCode has used its four retries and will not try again. If it can stay running, ask the person to run /markers ignore ${name}.`;
const COULD_NOT_CHECK = (name: string, reason: string) =>
  `Note: MomongaCode could not check whether a process started by an earlier command (marker ${name}) is still running (${reason}). The command ran. It will check again before the next command that runs a process or changes files in this session.`;

describe('the guard refuses only while a process the earlier command started can still run', () => {
  it('runs the next command when the marker is still held after its attempt, nobody is named and no member of the group can still run', async () => {
    const h = world('held', {}, new Set());
    await runOne(h, 'Leaver', 'first');
    expect(resultOf(await runOne(h, 'Writer', 'second'))).toMatchObject({ status: 'completed', output: 'wrote' });
    expect(h.askedGroups).toContain(LEAVER_PGID);
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(true);
  });

  it('refuses as before when a member of the group can still run', async () => {
    const h = world('held', {}, new Set([LEAVER_PGID]));
    await runOne(h, 'Leaver', 'first');
    const refused = resultOf(await runOne(h, 'Writer', 'second'));
    expect(refused.status).toBe('failed');
    expect(refused.output.startsWith(SETTLED_PREFIX(keyFor('run-1', 1, 'first')))).toBe(true);
  });
});

describe('decision 12: a marker held through the four occasions reaches the final notice', () => {
  it('names the marker and /markers ignore once all four retries are spent and a member of the group can still run', async () => {
    const h = world('held', {}, new Set([LEAVER_PGID]));
    await runOne(h, 'Leaver', 'first');
    const name = keyFor('run-1', 1, 'first');
    fs.writeFileSync(markerOf(h, 'first'), `r11110\ng${String(LEAVER_PGID).padStart(10, '0')}\n`);
    const refused = resultOf(await runOne(h, 'Writer', 'second'));
    expect(refused.status).toBe('failed');
    expect(refused.output).toBe(`${SETTLED_PREFIX(name)}${FINAL_NOTICE_END(name)}`);
    expect(h.sent).toEqual([]);
  });

  it('runs the command with the final notice once all four retries are spent, the marker is still held and no member of the group can still run', async () => {
    const h = world('held', {}, new Set());
    await runOne(h, 'Leaver', 'first');
    const name = keyFor('run-1', 1, 'first');
    fs.writeFileSync(markerOf(h, 'first'), 'r11110\n');
    expect(resultOf(await runOne(h, 'Writer', 'second'))).toEqual({ status: 'completed', output: `wrote\n${HELD_FINAL_NOTICE(name)}` });
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(true);
    expect(h.sent).toEqual([]);
  });
});

describe('the guard does not refuse when it cannot establish whether a process can still run', () => {
  it('runs with the could-not-check note and keeps the marker when the marker state cannot be read, even with a recorded group', async () => {
    const h = world('held', {}, new Set());
    await runOne(h, 'Leaver', 'first');
    const name = keyFor('run-1', 1, 'first');
    h.states.set(name, 'unknown');
    expect(resultOf(await runOne(h, 'Writer', 'second'))).toEqual({ status: 'completed', output: `wrote\n${COULD_NOT_CHECK(name, 'the marker state could not be read')}` });
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it('runs with the could-not-check note naming the refused process when the listing refused inspection, nobody is named and no member of the group can still run', async () => {
    const h = world('held', {}, new Set(), [{ pid: 4343, command: 'sleep', startedAt: 0 }]);
    await runOne(h, 'Leaver', 'first');
    const name = keyFor('run-1', 1, 'first');
    expect(resultOf(await runOne(h, 'Writer', 'second'))).toEqual({ status: 'completed', output: `wrote\n${COULD_NOT_CHECK(name, 'process 4343 (sleep) could not be inspected')}` });
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(true);
  });
});
