import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitConfigDiscovery, nodeCommandRunner } from '@momonga/foundation';
import type { CommandRunner } from '@momonga/foundation';
import { createTempDir } from '@momonga/testkit';

const made: string[] = [];

afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const repository = (): { work: string; env: Record<string, string> } => {
  const base = createTempDir();
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

    expect(counting.calls()).toBeGreaterThan(oneDiscovery);
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

    expect(counting.calls()).toBeGreaterThan(oneDiscovery);
  });

  it('discovers again on the next call when a file changed while the discovery ran', async () => {
    const { work, env } = repository();
    const config = path.join(work, '.git', 'config');
    const included = path.join(work, 'late.gitconfig');
    fs.writeFileSync(included, '[core]\n\tautocrlf = false\n');
    let calls = 0;
    let rewritten = false;
    const run: CommandRunner = async (command, args, options) => {
      calls += 1;
      const result = await nodeCommandRunner(command, args, options);
      if (args.includes('--get-regexp') && !rewritten) {
        rewritten = true;
        fs.appendFileSync(config, `[include]\n\tpath = ${included}\n`);
      }
      return result;
    };
    const discovery = createGitConfigDiscovery({ run });
    const signal = new AbortController().signal;

    await discovery.discover({ workingDirectory: work, env, signal });
    const next = await discovery.discover({ workingDirectory: work, env, signal });

    expect(next).toContain(included);
    expect(calls).toBeGreaterThan(0);
  });

  it('sees a rewrite of the same size with the same modification time', async () => {
    const { work, env } = repository();
    const config = path.join(work, '.git', 'config');
    fs.appendFileSync(config, '[user]\n\tname = aaaa\n');
    const fixed = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(config, fixed, fixed);
    const before = fs.statSync(config);
    const counting = countingRunner();
    const discovery = createGitConfigDiscovery({ run: counting.run });
    const signal = new AbortController().signal;
    await discovery.discover({ workingDirectory: work, env, signal });
    const once = counting.calls();

    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('aaaa', 'bbbb'));
    fs.utimesSync(config, fixed, fixed);
    expect(fs.statSync(config).size).toBe(before.size);
    expect(fs.statSync(config).mtimeMs).toBe(before.mtimeMs);
    await discovery.discover({ workingDirectory: work, env, signal });

    expect(counting.calls()).toBeGreaterThan(once);
  });
});
