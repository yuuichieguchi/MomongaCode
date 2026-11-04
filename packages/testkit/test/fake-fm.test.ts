import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_DETERMINISTIC_REPLY, FAKE_OS_BUILD, LSOF_PATH, REAL_PROCESS_TEST_TIMEOUT_MS, countFakeTokens, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';

const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const TESTKIT_SRC_URL = pathToFileURL(path.resolve(import.meta.dirname, '..', 'src')).href;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ff-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const minimalEnv = (dir: string, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: MINIMAL_PATH,
  HOME: dir,
  TMPDIR: dir,
  ...extra,
});

const runFm = (binary: string, args: string[], env: Record<string, string>, input?: string) =>
  spawnSync(binary, args, { env, input: input ?? '', encoding: 'utf8', timeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (predicate: () => boolean, description: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await pause(25);
  }
};

const send = (socketPath: string, method: string, urlPath: string, body?: unknown): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      { socketPath, method, path: urlPath, headers: payload === undefined ? {} : { 'content-type': 'application/json' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(payload);
  });

const startServe = async (binary: string, socketPath: string, env: Record<string, string>): Promise<number> => {
  const child = spawn(binary, ['serve', '--socket', socketPath], { env, detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('fake fm serve did not spawn');
  cleanups.push(() => killGroupsForCleanup([pid]));
  await until(() => fs.existsSync(socketPath), 'the fake fm socket');
  return pid;
};

const completionBody = { model: 'system', messages: [{ role: 'user', content: 'hello there' }] };

const streamedContentOf = (sse: string): string =>
  sse
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as { choices?: Array<{ delta?: { content?: string } }> })
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? '')
    .join('');

describe('createFakeFm script file', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('writes an executable regular file whose shebang is the absolute node binary', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const stat = fs.lstatSync(fm.binaryPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o100).toBe(0o100);
    expect(path.dirname(fm.binaryPath)).toBe(dir);
    const firstLine = fs.readFileSync(fm.binaryPath, 'utf8').split('\n')[0];
    expect(firstLine).toBe(`#!${process.execPath}`);
    expect(path.isAbsolute(process.execPath)).toBe(true);
  });

  it('imports testkit modules by absolute file URL', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const source = fs.readFileSync(fm.binaryPath, 'utf8');
    expect(source).toContain(`${TESTKIT_SRC_URL}/`);
    expect(source).not.toMatch(/from ['"]@momonga\/testkit['"]/);
    expect(source).not.toMatch(/from ['"]\.\.?\//);
  });

  it('keeps its JSON config file next to the script', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    expect(path.dirname(fm.configPath)).toBe(path.dirname(fm.binaryPath));
    expect(fm.configPath.endsWith('.json')).toBe(true);
    expect(fs.existsSync(fm.configPath)).toBe(true);
  });
});

describe('createFakeFm under the minimal env', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('exits 0 for license --status', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const result = runFm(fm.binaryPath, ['license', '--status'], minimalEnv(dir));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('exits 0 for available', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const result = runFm(fm.binaryPath, ['available'], minimalEnv(dir));
    expect(result.status).toBe(0);
  });

  it('prints the token count of stdin for count-tokens', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const text = 'alpha beta  gamma\ndelta';
    const result = runFm(fm.binaryPath, ['count-tokens', '-q'], minimalEnv(dir), text);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(String(countFakeTokens(text)));
  });

  it('prints zero for empty stdin', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const result = runFm(fm.binaryPath, ['count-tokens', '-q'], minimalEnv(dir), '');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0');
  });

  it('serves fm\'s wire on the given socket: a request without stream is answered with a Chat Completions SSE stream', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const socketPath = path.join(dir, 'fm.sock');
    await startServe(fm.binaryPath, socketPath, minimalEnv(dir));
    let health = { status: 0, text: '' };
    await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        health = await send(socketPath, 'GET', '/health').catch(() => ({ status: 0, text: '' }));
        if (health.status === 200) return;
        await pause(25);
      }
    })();
    expect(health.status).toBe(200);
    expect(completionBody).not.toHaveProperty('stream');
    const completion = await send(socketPath, 'POST', '/v1/chat/completions', completionBody);
    expect(completion.status).toBe(200);
    expect(completion.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(streamedContentOf(completion.text)).toBe(FAKE_DETERMINISTIC_REPLY);
  });

  it('applies the serve scenario from the JSON config file', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const errorBody = { error: { message: 'configured failure', type: 'invalid_request_error', param: null, code: 'configured' } };
    fm.configure({ serve: { scenario: 'tools-ok', script: [{ kind: 'error', status: 418, body: errorBody }] } });
    const socketPath = path.join(dir, 'fm.sock');
    await startServe(fm.binaryPath, socketPath, minimalEnv(dir));
    let completion = { status: 0, text: '' };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      completion = await send(socketPath, 'POST', '/v1/chat/completions', completionBody).catch(() => ({ status: 0, text: '' }));
      if (completion.status !== 0) break;
      await pause(25);
    }
    expect(completion.status).toBe(418);
    expect(JSON.parse(completion.text)).toEqual(errorBody);
  });

  it('appends argv, pid and the received env to the env-dump file for every invocation', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const dumpFile = path.join(dir, 'env.jsonl');
    fm.configure({ envDumpFile: dumpFile });
    const env = minimalEnv(dir, { LANG: 'en_US.UTF-8', MOMONGA_CANARY: 'canary-value' });
    expect(runFm(fm.binaryPath, ['available'], env).status).toBe(0);
    expect(runFm(fm.binaryPath, ['license', '--status'], env).status).toBe(0);
    const records = fs
      .readFileSync(dumpFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.argv)).toEqual([['available'], ['license', '--status']]);
    for (const record of records) {
      expect(Number.isInteger(record.pid)).toBe(true);
      expect(record.pid).not.toBe(process.pid);
      expect(record.env.MOMONGA_CANARY).toBe('canary-value');
      expect(record.env.LANG).toBe('en_US.UTF-8');
      expect(record.env.PATH).toBe(MINIMAL_PATH);
      expect(record.env.HOME).toBe(dir);
    }
  });

  it('writes nothing when no env-dump file is configured', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    expect(runFm(fm.binaryPath, ['available'], minimalEnv(dir)).status).toBe(0);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))).toEqual([]);
  });
});

describe('fakeExec', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.each(['/usr/bin/sw_vers', 'sw_vers'])('answers %s -buildVersion with the fake build', async (file) => {
    expect(await fakeExec(file, ['-buildVersion'])).toEqual({ exitCode: 0, stdout: `${FAKE_OS_BUILD}\n`, stderr: '' });
  });

  it('uses a build string shaped like a macOS build number', () => {
    expect(FAKE_OS_BUILD).toMatch(/^[0-9]{2}[A-Z][0-9]+[a-z]?$/);
  });

  it('runs any other command for real and reports its exit code', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    expect(await fakeExec(fm.binaryPath, ['license', '--status'])).toMatchObject({ exitCode: 0 });
    expect(await fakeExec('/usr/bin/false', [])).toMatchObject({ exitCode: 1 });
  });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const pgidOf = (pid: number): number => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());

const holdersOf = (file: string): number[] => {
  const result = spawnSync(LSOF_PATH, ['-t', file], { encoding: 'utf8' });
  return result.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map(Number)
    .sort((a, b) => a - b);
};

describe('createFakeFm serveSurvivorPidFile', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('forks a SIGTERM-ignoring child in the serve group that keeps the marker fd 3', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const pidFile = path.join(dir, 'survivor.pid');
    fm.configure({ serveSurvivorPidFile: pidFile });
    const marker = path.join(dir, 'marker');
    const markerFd = fs.openSync(marker, 'w', 0o600);
    const leader = spawn(fm.binaryPath, ['serve', '--socket', path.join(dir, 'fm.sock')], {
      env: minimalEnv(dir),
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', markerFd],
    });
    fs.closeSync(markerFd);
    const leaderPid = leader.pid;
    if (leaderPid === undefined) throw new Error('fake fm serve did not spawn');
    cleanups.push(() => killGroupsForCleanup([leaderPid]));
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').endsWith('\n'), 'the survivor pid file');
    const survivorPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(survivorPid).not.toBe(leaderPid);
    expect(pgidOf(survivorPid)).toBe(leaderPid);
    expect(holdersOf(marker)).toEqual([leaderPid, survivorPid].sort((a, b) => a - b));

    const exited = new Promise<void>((resolve) => leader.once('exit', () => resolve()));
    process.kill(-leaderPid, 'SIGTERM');
    await exited;
    await pause(200);
    expect(isAlive(survivorPid)).toBe(true);
    expect(holdersOf(marker)).toEqual([survivorPid]);
  });

  it('forks nothing when the option is not set', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const socketPath = path.join(dir, 'fm.sock');
    const leaderPid = await startServe(fm.binaryPath, socketPath, minimalEnv(dir));
    const others = execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, pgid]) => pgid === leaderPid && pid !== leaderPid);
    expect(others).toEqual([]);
  });
});

describe('createFakeFm serveDetachedHelperPidFile', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('forks a SIGTERM-ignoring helper in the serve group that does not hold the marker', async () => {
    const dir = makeDir();
    const fm = await createFakeFm({ dir });
    const pidFile = path.join(dir, 'helper.pid');
    fm.configure({ serveDetachedHelperPidFile: pidFile });
    const marker = path.join(dir, 'marker');
    const markerFd = fs.openSync(marker, 'w', 0o600);
    const leader = spawn(fm.binaryPath, ['serve', '--socket', path.join(dir, 'fm.sock')], {
      env: minimalEnv(dir),
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', markerFd],
    });
    fs.closeSync(markerFd);
    const leaderPid = leader.pid;
    if (leaderPid === undefined) throw new Error('fake fm serve did not spawn');
    cleanups.push(() => killGroupsForCleanup([leaderPid]));
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').endsWith('\n'), 'the helper pid file');
    const helperPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(helperPid).not.toBe(leaderPid);
    expect(pgidOf(helperPid)).toBe(leaderPid);
    await until(() => holdersOf(marker).includes(leaderPid), 'the leader to hold the marker');
    expect(holdersOf(marker)).toEqual([leaderPid]);

    const exited = new Promise<void>((resolve) => leader.once('exit', () => resolve()));
    process.kill(-leaderPid, 'SIGTERM');
    await exited;
    await pause(200);
    expect(isAlive(helperPid)).toBe(true);
    expect(holdersOf(marker)).toEqual([]);
  });
});
