import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProcessAlive } from '@momonga/foundation';
import { assertHomeSocketBudget, registerCleanup, spawnTracked, tempDirPrefixFor, testRunToken, withTempDir } from '@momonga/testkit';

const readLine = (stream: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      stream.off('data', onData);
      resolve(buffered.slice(0, newline));
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });

describe('test run token', () => {
  it('is the four hex characters the leak guard put into the environment', () => {
    expect(testRunToken()).toMatch(/^[0-9a-f]{4}$/);
    expect(process.env['MOMONGA_TEST_RUN']).toBe(testRunToken());
  });
});

describe('withTempDir', () => {
  const created: string[] = [];

  it('creates a 0700 directory in the temp root carrying the run token prefix', (context) => {
    const dir = withTempDir(context);
    created.push(dir);
    expect(path.dirname(dir)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(dir)).toMatch(new RegExp(`^${tempDirPrefixFor(testRunToken())}[A-Za-z0-9]{6}$`));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(locked, 'inner', 'file'), 'x');
    fs.chmodSync(path.join(locked, 'inner'), 0o500);
    fs.chmodSync(locked, 0o500);
  });

  it('removed the previous directory, read-only subdirectories included', () => {
    expect(created).toHaveLength(1);
    expect(fs.existsSync(created[0] as string)).toBe(false);
  });

  it('returns a home whose longest socket stays below the limit', (context) => {
    const home = withTempDir(context, { asHome: true });
    expect(Buffer.byteLength(path.join(home, '.momonga', 'run', 'supervisor.sock'))).toBeLessThan(104);
  });
});

describe('assertHomeSocketBudget', () => {
  it('accepts a home whose supervisor socket is 103 bytes', () => {
    expect(() => assertHomeSocketBudget(`/${'h'.repeat(73)}`)).not.toThrow();
  });

  it('rejects a home whose supervisor socket reaches 104 bytes, naming the socket and the budget', () => {
    const home = `/${'h'.repeat(74)}`;
    expect(() => assertHomeSocketBudget(home)).toThrow(`${home}/.momonga/run/supervisor.sock is 104 bytes`);
    expect(() => assertHomeSocketBudget(home)).toThrow(/budget/);
  });
});

describe('registerCleanup', () => {
  const order: string[] = [];

  it('registers cleanups', (context) => {
    registerCleanup(context, () => void order.push('first'));
    registerCleanup(context, () => void order.push('second'));
    expect(order).toEqual([]);
  });

  it('ran them after the test, last registered first', () => {
    expect(order).toEqual(['second', 'first']);
  });
});

describe('spawnTracked', () => {
  const pids: number[] = [];

  it('spawns a child in its own process group and its grandchild with it', async (context) => {
    const child = spawnTracked(context, '/bin/sh', ['-c', '/bin/sleep 60 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = Number.parseInt(await readLine(child.stdout as NodeJS.ReadableStream), 10);
    pids.push(child.pid, grandchild);
    expect(isProcessAlive(child.pid)).toBe(true);
    expect(isProcessAlive(grandchild)).toBe(true);
  });

  it('killed the child and its grandchild after the test', () => {
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(isProcessAlive(pid), String(pid)).toBe(false);
  });

  it('kills a child spawned outside a new process group', (context) => {
    const child = spawnTracked(context, '/bin/sleep', ['60'], { stdio: 'ignore', detached: false });
    pids.push(child.pid);
    expect(isProcessAlive(child.pid)).toBe(true);
  });

  it('killed the non-detached child', () => {
    expect(isProcessAlive(pids[2] as number)).toBe(false);
  });
});
