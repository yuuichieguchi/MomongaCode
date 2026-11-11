import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitConfigDiscovery, nodeCommandRunner } from '@momonga/foundation';
import type { CommandRunner } from '@momonga/foundation';

const made: string[] = [];

afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const repository = (): { work: string; env: Record<string, string> } => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-config-fingerprint-')));
  made.push(base);
  const home = path.join(base, 'home');
  const work = path.join(base, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q', work], { env });
  return { work, env };
};

const countingRunner = (): { run: CommandRunner; calls: () => number } => {
  let count = 0;
  return {
    run: (command, args, options) => {
      count += 1;
      return nodeCommandRunner(command, args, options);
    },
    calls: () => count,
  };
};

describe('the git configuration files of a working tree', () => {
  it('are discovered once while their files do not change, and again after a file changed', async () => {
    const { work, env } = repository();
    const counting = countingRunner();
    const discovery = createGitConfigDiscovery({ run: counting.run });
    const signal = new AbortController().signal;

    const first = await discovery.discover({ workingDirectory: work, env, signal });
    const oneDiscovery = counting.calls();
    for (let step = 0; step < 9; step += 1) expect(await discovery.discover({ workingDirectory: work, env, signal })).toEqual(first);

    expect(oneDiscovery).toBeGreaterThan(0);
    expect(counting.calls()).toBe(oneDiscovery);

    const included = path.join(work, 'extra.gitconfig');
    fs.writeFileSync(included, '[core]\n\tautocrlf = false\n');
    fs.appendFileSync(path.join(work, '.git', 'config'), `[include]\n\tpath = ${included}\n`);
    const changed = await discovery.discover({ workingDirectory: work, env, signal });

    expect(counting.calls()).toBe(oneDiscovery * 2);
    expect(changed).toContain(included);
  });

  it('are discovered again when a global configuration file appears', async () => {
    const { work, env } = repository();
    const counting = countingRunner();
    const discovery = createGitConfigDiscovery({ run: counting.run });
    const signal = new AbortController().signal;

    await discovery.discover({ workingDirectory: work, env, signal });
    const oneDiscovery = counting.calls();
    fs.writeFileSync(path.join(env['HOME'] as string, '.gitconfig'), '[user]\n\tname = x\n');
    await discovery.discover({ workingDirectory: work, env, signal });

    expect(counting.calls()).toBe(oneDiscovery * 2);
  });
});
