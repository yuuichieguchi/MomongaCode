import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxPolicyError } from '@momonga/sandbox';
import { buildSandboxPolicy } from '@momonga/tools';

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
  });
};

describe('buildSandboxPolicy and the Unix socket allow list', () => {
  it('allows no Unix socket by default and keeps the network denied', () => {
    const policy = build();
    expect(policy.unixSocketAllow).toEqual([]);
    expect(policy.network).toBe('deny');
  });

  it('carries the listed paths and never opens the network for them', () => {
    const policy = build(['/var/run/agent', '/var/run/agent', '/tmp/x.sock']);
    expect(policy.unixSocketAllow).toEqual(['/var/run/agent', '/tmp/x.sock']);
    expect(policy.network).toBe('deny');
  });

  it('refuses an entry that is not an absolute path', () => {
    expect(() => build(['agent.sock'])).toThrow(SandboxPolicyError);
  });
});
