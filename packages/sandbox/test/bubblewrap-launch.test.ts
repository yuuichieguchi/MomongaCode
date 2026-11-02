import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { createBubblewrapSandbox } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { makeTempDir, run } from './helpers.ts';

const FAKE_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do
  if [ "$1" = "--ro-bind" ] && [ "$2" = "/dev/null" ] && [ ! -e "$3" ]; then : > "$3"; fi
  shift
done
shift
exec "$@"
`;

let base = '';
let work = '';
let bwrap = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(base, 'tmp'));
  bwrap = path.join(base, 'bwrap');
  fs.writeFileSync(bwrap, FAKE_BWRAP, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = (writeDenied: string[]): SandboxPolicy => ({
  writableRoots: [work],
  writeDenied,
  writeDeniedLiterals: [],
  readDenied: [],
  network: 'deny',
  fileRules: EMPTY_FILE_RULES,
  protectedSet: EMPTY_PROTECTED_SET,
});

const sandbox = () => createBubblewrapSandbox({ bwrapPath: bwrap, tmpRoot: path.join(base, 'tmp'), killGraceMs: 300 });

describe('bubblewrap launch (a stand-in bwrap that creates the /dev/null mount points; the real bwrap never ran on this host)', () => {
  it('forwards the command stdin to the sandboxed process, as Seatbelt and the unsandboxed launcher do', async () => {
    const proc = sandbox().spawn({ argv: ['/bin/cat'], cwd: work, env: { PATH: '/usr/bin:/bin' }, stdin: '{"tool_input":1}' }, policy([]), new AbortController().signal);
    const result = await run(proc);
    expect(result.stdout).toBe('{"tool_input":1}');
    expect(result.code).toBe(0);
  });

  it('holds a placeholder for a protected path that does not exist yet while the command runs and removes it afterwards', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const proc = sandbox().spawn(
      { argv: ['/bin/sh', '-c', 'test -f .git && ! mkdir .git 2>/dev/null && echo pinned'], cwd: work, env: { PATH: '/usr/bin:/bin' } },
      policy([hooks]),
      new AbortController().signal,
    );
    const result = await run(proc);
    expect(result.stdout.trim()).toBe('pinned');
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('keeps a placeholder until the last command that reserved it has exited', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const shared = sandbox();
    const gate = path.join(base, 'gate');
    execFileSync('/usr/bin/mkfifo', [gate]);
    const first = shared.spawn({ argv: ['/bin/cat', gate], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    const second = shared.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    await run(second);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
    fs.writeFileSync(gate, 'open');
    await run(first);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('never deletes a placeholder path that holds content', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const proc = sandbox().spawn({ argv: ['/bin/sh', '-c', 'echo kept > .git'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    await run(proc);
    expect(fs.readFileSync(path.join(work, '.git'), 'utf8')).toBe('kept\n');
  });
});
