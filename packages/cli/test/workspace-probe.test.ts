import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { nodeWorkspaceProbe } from '../src/eval/workspace-probe.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

let root = '';
let dir = '';
let base = '';

const seed = (target: string): void => {
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.writeFileSync(path.join(target, 'check.sh'), 'test -f done.txt\n');
  fs.writeFileSync(path.join(target, 'src', 'a.txt'), 'a');
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-probe-')));
  dir = path.join(root, 'work');
  base = path.join(root, 'base');
  seed(dir);
  seed(base);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const probe = () => nodeWorkspaceProbe({ PATH: '/usr/bin:/bin' });

describe('nodeWorkspaceProbe', () => {
  it('runs a command in the workspace and reports its exit code', async () => {
    expect(await probe().run('sh check.sh', 30_000, dir)).toEqual({ exitCode: 1, timedOut: false });
    fs.writeFileSync(path.join(dir, 'done.txt'), '');
    expect(await probe().run('sh check.sh', 30_000, dir)).toEqual({ exitCode: 0, timedOut: false });
  });

  it('reports a timeout when the command outruns it', async () => {
    expect(await probe().run('sleep 30', 300, dir)).toEqual({ exitCode: null, timedOut: true });
  });

  it('changes the digest of a file when it changes, and not when another one does', async () => {
    const before = await probe().digest(dir, ['src/a.txt']);
    fs.writeFileSync(path.join(dir, 'done.txt'), 'x');
    expect(await probe().digest(dir, ['src/a.txt'])).toBe(before);
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'changed');
    expect(await probe().digest(dir, ['src/a.txt'])).not.toBe(before);
  });

  it('lists the files that differ from the base, whether edited, added or deleted', async () => {
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'edited');
    fs.writeFileSync(path.join(dir, 'done.txt'), '');
    fs.rmSync(path.join(dir, 'check.sh'));
    expect(await probe().changedPaths(dir, base)).toEqual(['check.sh', 'done.txt', 'src/a.txt']);
  });
});
