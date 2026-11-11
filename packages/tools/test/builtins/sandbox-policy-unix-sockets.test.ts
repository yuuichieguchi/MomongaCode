import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxPolicyError } from '@momonga/sandbox';
import { buildSandboxPolicy } from '@momonga/tools';
import { NEVER_CANCELLED } from '@momonga/testkit';

const created: string[] = [];

const makeHome = (): { home: string; project: string } => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sock-')));
  created.push(root);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  return { home, project };
};

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const build = (unixSocketAllow?: readonly string[]) => {
  const { home, project } = makeHome();
  return buildSandboxPolicy({
    roots: [project],
    home,
    sessionsTmpRoot: path.join(home, 'tmp-sessions'),
    fileRules: EMPTY_FILE_RULES,
    protectedSet: EMPTY_PROTECTED_SET,
    ...(unixSocketAllow === undefined ? {} : { unixSocketAllow }),
  }, NEVER_CANCELLED);
};

describe('buildSandboxPolicy and the Unix socket allow list', () => {
  it('allows no Unix socket by default and keeps the network denied', async () => {
    const policy = build();
    expect((await policy).unixSocketAllow).toEqual([]);
    expect((await policy).network).toBe('deny');
  });

  it('carries the listed paths and never opens the network for them', async () => {
    const policy = build(['/var/run/agent', '/var/run/agent', '/tmp/x.sock']);
    expect((await policy).unixSocketAllow).toEqual(['/var/run/agent', '/tmp/x.sock']);
    expect((await policy).network).toBe('deny');
  });

  it('refuses an entry that is not an absolute path', async () => {
    await expect((async () => build(['agent.sock']))()).rejects.toThrow(SandboxPolicyError);
  });
});
