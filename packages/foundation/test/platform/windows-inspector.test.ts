import { sleepDrivenTiming } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { reconcileProcessGroup } from '../../src/process-markers.ts';
import type { ProcessGroupPort } from '../../src/platform/group-port.ts';
import type { CommandResult, CommandRunner } from '../../src/platform/command-runner.ts';
import type { KeptMembers } from '../../src/platform/windows-kept-groups.ts';
import { createKeptGroupControl } from '../../src/platform/windows-kept-groups.ts';
import { createProcessGroupPort } from '../../src/platform/group-port.ts';
import { recordMarkerGroup } from '../../src/platform/marker-record.ts';
import { fakeKeeperHost } from '../support/fake-keeper.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createAsyncSignalSender } from '../../src/platform/group-port.ts';
import { createWindowsInspector } from '../../src/platform/windows-inspector.ts';
import { parsePidList, parseStartTime } from '../../src/platform/windows-parsers.ts';
import { holdersScript, powershellLiteral, startTimeScript } from '../../src/platform/windows-scripts.ts';

const LIVE = { signal: new AbortController().signal };

const ENV = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const decodeScript = (args: readonly string[]): string => Buffer.from(args[args.length - 1] as string, 'base64').toString('utf16le');

const NO_JOBS = {
  groups: {
    members: async (pgid: number): Promise<KeptMembers> => {
      throw new Error(`the keeper of process group ${pgid} closed its pipe before it listed the members`);
    },
    leads: (): boolean => false,
  },
  alive: (): boolean => false,
};

const listing = (pids: number[]): KeptMembers => ({ kind: 'members', pids });

describe('windows parsers (shape of ConvertTo-Json -Compress output)', () => {
  it('parses pid lists and creation times', () => {
    expect(parsePidList('[12,34]')).toEqual([12, 34]);
    expect(parsePidList('12')).toEqual([12]);
    expect(parsePidList('')).toEqual([]);
    expect(() => parsePidList('[0]')).toThrow('positive integer');
    expect(parseStartTime('133400000000000001\r\n')).not.toEqual(parseStartTime('133400000000000002\r\n'));
    expect(parseStartTime('')).toBeUndefined();
    expect(() => parseStartTime('Monday')).toThrow('integer');
  });
});

describe('windows scripts', () => {
  it('quotes single quotes in literals', () => {
    expect(powershellLiteral("C:\\Users\\O'Brien\\m")).toBe("'C:\\Users\\O''Brien\\m'");
    expect(holdersScript("C:\\a'b")).toContain("Holders('C:\\a''b')");
  });

  it('rejects a non-positive pid for the creation-time query', () => {
    expect(() => startTimeScript(0)).toThrow(RangeError);
    expect(startTimeScript(42)).toContain('42');
    expect(startTimeScript(42)).toContain('GetProcessTimes');
  });
});

describe('windows inspector through an injected command runner', () => {
  const calls: Array<{ file: string; args: readonly string[]; env: Readonly<Record<string, string>> | undefined }> = [];
  const runnerReturning = (result: Partial<CommandResult>) => async (file: string, args: readonly string[], options: { env: Readonly<Record<string, string>> | undefined }): Promise<CommandResult> => {
    calls.push({ file, args, env: options.env });
    return { exitCode: 0, stdout: '', stderr: '', ...result };
  };

  it('asks GetProcessTimes for the creation FILETIME of one pid', async () => {
    calls.length = 0;
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: '133400000000000001\r\n' }), env: ENV, ...NO_JOBS });
    const read = await inspector.startTimeOf(321, LIVE);
    expect(read.kind).toBe('value');
    expect(await createWindowsInspector({ run: runnerReturning({ stdout: '133400000000000002\r\n' }), env: ENV, ...NO_JOBS }).startTimeOf(321, LIVE)).not.toEqual(read);
    expect(calls[0]?.file).toBe(POWERSHELL);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive']);
    expect(decodeScript(calls[0]?.args ?? [])).toContain('GetProcessTimes');
    expect(decodeScript(calls[0]?.args ?? [])).toContain('321');
    expect(calls[0]?.env).toEqual(ENV);
  });

  it('reports a pid without a row as gone', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: '\r\n' }), env: ENV, ...NO_JOBS });
    expect(await inspector.startTimeOf(321, LIVE)).toEqual({ kind: 'gone' });
  });

  it('reports a failing powershell as a deterministic failure instead of no process', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ exitCode: 1, stderr: 'boom' }), env: ENV, ...NO_JOBS });
    expect(await inspector.startTimeOf(321, LIVE)).toEqual({
      kind: 'failed',
      cause: 'deterministic',
      evidence: { kind: 'exit', exitCode: 1, detail: 'powershell exited with 1: boom' },
    });
  });

  it('reports a timed-out powershell as transient', async () => {
    const timedOut = Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGKILL' });
    const inspector = createWindowsInspector({ run: async () => Promise.reject(timedOut), env: ENV, ...NO_JOBS });
    expect(await inspector.startTimeOf(321, LIVE)).toMatchObject({ kind: 'failed', cause: 'transient', evidence: { kind: 'timeout' } });
  });

  it('reports output it cannot parse as a deterministic failure', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: 'Monday' }), env: ENV, ...NO_JOBS });
    expect(await inspector.startTimeOf(321, LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'unparseable' } });
  });

  it('needs SystemRoot to locate powershell', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({}), env: {}, ...NO_JOBS });
    expect(await inspector.startTimeOf(321, LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { detail: expect.stringContaining('SystemRoot') } });
  });

  it('lists marker holders through the Restart Manager', async () => {
    calls.length = 0;
    const inspector = createWindowsInspector({ run: runnerReturning({ stdout: '[812,4096]' }), env: ENV, ...NO_JOBS });
    expect(await inspector.holdersOf('C:\\Users\\a\\marker', LIVE)).toEqual({ kind: 'value', value: [812, 4096] });
    const script = decodeScript(calls[0]?.args ?? []);
    expect(script).toContain('rstrtmgr.dll');
    expect(script).toContain("Holders('C:\\Users\\a\\marker')");
  });

  it('maps a holder to the candidate job whose keeper lists it, the keeper itself to its own job, any other live pid to itself, and leaves out a pid that is gone', async () => {
    const asked: number[] = [];
    const inspector = createWindowsInspector({
      run: runnerReturning({}),
      env: ENV,
      groups: {
        members: async (pgid) => {
          asked.push(pgid);
          return listing(pgid === 100 ? [200, 300] : []);
        },
        leads: (pgid) => pgid === 100,
      },
      alive: (pid) => pid === 100 || pid === 400,
    });
    expect(await inspector.groupsOf([100, 300, 400, 12345], [100], LIVE)).toEqual({
      kind: 'value',
      value: new Map([
        [100, 100],
        [300, 100],
        [400, 400],
      ]),
    });
    expect(asked).toEqual([100]);
  });

  it('does not take a live pid equal to the candidate number as that group when this process does not hold the keeper of that job', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({}), env: ENV, groups: { members: async () => listing([200]), leads: () => false }, alive: (pid) => pid === 100 || pid === 200 });
    expect(await inspector.groupsOf([100, 200], [100], LIVE)).toEqual({ kind: 'value', value: new Map([[200, 100]]) });
  });

  it('gives no members for a candidate the keeper control does not know', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({}), env: ENV, groups: { members: async () => ({ kind: 'unknown' }), leads: () => false }, alive: () => true });
    expect(await inspector.groupsOf([300], [100], LIVE)).toEqual({ kind: 'value', value: new Map([[300, 300]]) });
  });

  it('reports a failed read, not a group, when the keeper cannot answer for a candidate', async () => {
    const inspector = createWindowsInspector({ run: runnerReturning({}), env: ENV, ...NO_JOBS });
    expect(await inspector.groupsOf([300], [100], LIVE)).toMatchObject({ kind: 'failed' });
  });
});

describe('windows process group port and signal sender', () => {
  it('sends negative pids to the group port and signal 0 as an existence check', async () => {
    const calls: string[] = [];
    const send = createAsyncSignalSender('win32', () => ({
      signal: async (pgid, signal) => void calls.push(`signal ${pgid} ${signal}`),
      alive: async (pgid) => pgid === 100,
    }));
    await send(-100, 'SIGTERM', LIVE);
    await send(-100, 0, LIVE);
    await expect(send(-5, 0, LIVE)).rejects.toMatchObject({ code: 'ESRCH' });
    expect(calls).toEqual(['signal 100 SIGTERM']);
  });
});

describe('a Windows start time read that OpenProcess refuses (design 19.6 point 15)', () => {
  const failingWith = (stderr: string): CommandRunner => async () => ({ exitCode: 1, stdout: '', stderr });

  it('asks the process table for the pid when OpenProcess answers error 87, instead of taking 87 alone as gone', () => {
    const script = startTimeScript(4242);
    expect(script).toContain('Win32_Process');
    expect(script).toContain('4242');
  });

  it('reports gone when the script finds no row for the pid', async () => {
    expect(await createWindowsInspector({ run: async () => ({ exitCode: 0, stdout: '\r\n', stderr: '' }), env: ENV, ...NO_JOBS }).startTimeOf(4242, LIVE)).toEqual({ kind: 'gone' });
  });

  it.each([
    ['error 87 with a row in the process table', 'Exception calling "Creation" with "1" argument(s): "The parameter is incorrect" (87)'],
    ['error 5', 'Exception calling "Creation" with "1" argument(s): "Access is denied" (5)'],
  ])('reports %s as a failed read', async (_case, stderr) => {
    expect(await createWindowsInspector({ run: failingWith(stderr), env: ENV, ...NO_JOBS }).startTimeOf(4242, LIVE)).toMatchObject({ kind: 'failed' });
  });

  it('gives a holder whose start time read fails with error 5 no signal, and reports it left alone', async () => {
    const runner: CommandRunner = async (_file, args) => {
      const script = decodeScript(args);
      if (script.includes('GetProcessTimes')) return { exitCode: 1, stdout: '', stderr: 'Exception calling "Creation" with "1" argument(s): "Access is denied" (5)' };
      if (script.includes('rstrtmgr.dll')) return { exitCode: 0, stdout: '[4242]', stderr: '' };
      throw new Error(`no other script is run: ${script}`);
    };
    const inspector = createWindowsInspector({ run: runner, env: ENV, groups: { members: async () => listing([]), leads: () => false }, alive: () => true });
    const sent: Array<[number, NodeJS.Signals | 0]> = [];
    const groupPort: ProcessGroupPort = { signal: async (pgid, signal) => void sent.push([-pgid, signal]), alive: async () => false };
    let now = 0;
    const result = await reconcileProcessGroup(
      { pgid: 4000, marker: 'C:\\Users\\a\\marker' },
      { killGraceMs: 100, kill: (pid, signal) => void sent.push([pid, signal]), groupPort, timing: sleepDrivenTiming({ now: () => now, sleep: async (ms) => void (now += ms) }), inspector, signal: new AbortController().signal },
    );
    expect(sent.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect(result.leftAlonePids).toEqual([4242]);
  });
});

describe('a marker of a group this process did not launch, with no job name', () => {
  it('gives the unknown group answer: the reaper keeps the group, reports it and signals nothing', async () => {
    const marker = path.join(makeTemporaryDirectory(), 'marker');
    fs.writeFileSync(marker, '');
    await recordMarkerGroup(marker, 5000, { names: { nameOf: () => undefined, recall: () => undefined } });
    const fake = fakeKeeperHost();
    const kept = createKeptGroupControl(fake.host);
    const groupPort = createProcessGroupPort('win32', { run: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }), env: ENV, kept });
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: '[]', stderr: '' });
    const inspector = createWindowsInspector({ run: runner, env: ENV, groups: kept, alive: () => true });
    const sent: Array<[number, NodeJS.Signals | 0]> = [];
    let now = 0;
    const result = await reconcileProcessGroup(
      { pgid: 5000, marker },
      { killGraceMs: 100, kill: (pid, signal) => void sent.push([pid, signal]), groupPort, timing: sleepDrivenTiming({ now: () => now, sleep: async (ms) => void (now += ms) }), inspector, signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ outcome: 'unknown', stopped: false, leftAloneGroup: 5000 });
    expect(result.output).toContain('records no name');
    expect(sent.filter(([, signal]) => signal !== 0)).toEqual([]);
    expect(fake.keepers).toHaveLength(0);
  });
});
