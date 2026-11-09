import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs, hostKernelLock, sidecarOf } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import { START_MS, makeAbandonedDirectory } from './helpers.ts';
import { launchRuntime, sessionEnvFor, startStack, stepsLogged } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const DAY_MS = 86_400_000;
const RUNTIME_MS = START_MS + 8 * DAY_MS;

type Seeded = { idle: string; recent: string; active: string; activeSymlink: string };

const seedSessions = async (temp: RunHome): Promise<Seeded> => {
  await ensureMomongaDirs(temp.paths);
  const clock = createFakeClock(START_MS);
  const store = openRuntimeStore({ path: temp.paths.databases.runtime, home: temp.home, clock, leaseMs: 30_000, maxAttempts: 5, maxTotalAttempts: 20 });
  const session = () => store.createSession({ cwd: temp.project, env: { ...sessionEnvFor(temp.home) }, permissionMode: 'default', modelAlias: 'default' }).id;
  try {
    const idle = session();
    const active = session();
    const activeSymlink = session();
    for (const id of [active, activeSymlink]) store.createRunAndEnqueue(id, { input: 'Say hello', timeoutMs: 6 * 3_600_000, limits: {}, pins: {} });
    clock.set(RUNTIME_MS - DAY_MS);
    const recent = session();
    return { idle, recent, active, activeSymlink };
  } finally {
    store.close();
  }
};

describe('startup tmp sweeps through startRuntimeProcess (system timers, fake clock, in-process gateway)', () => {
  it('removes spawn entries whose sidecar no one holds at start, and keeps a spawn symlink, which cannot carry a lock, without following it', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    await ensureMomongaDirs(stack.temp.paths);
    const spawnRoot = stack.temp.paths.tmp.spawn;
    makeAbandonedDirectory(path.join(spawnRoot, 'rg-1'));
    fs.mkdirSync(path.join(spawnRoot, 'rg-1', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(spawnRoot, 'rg-1', 'nested', 'f'), 'x');
    const outside = path.join(stack.temp.root, 'outside-spawn');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.symlinkSync(outside, path.join(spawnRoot, 'link'));
    const launched = await launchRuntime(stack.temp, { clock: createFakeClock(RUNTIME_MS) });
    expect(stepsLogged(launched.logger)).toContain('tmp-sweep');
    expect(fs.readdirSync(spawnRoot)).toEqual(['link']);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('sweeps session dirs at start under their sidecar claims: unknown and idle sessions are removed, recent and active ones are kept, symlinks and a dir with no sidecar are kept, and symlinks are never followed', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const seeded = await seedSessions(stack.temp);
    const root = stack.temp.paths.tmp.sessions;
    const outside = path.join(stack.temp.root, 'outside-sessions');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    for (const id of ['unknown-session', seeded.idle, seeded.recent, seeded.active]) {
      makeAbandonedDirectory(path.join(root, id));
      fs.mkdirSync(path.join(root, id, 'work'), { recursive: true });
      fs.writeFileSync(path.join(root, id, 'work', 'f'), 'x');
    }
    fs.symlinkSync(outside, path.join(root, seeded.activeSymlink));
    fs.symlinkSync(outside, path.join(root, 'unknown-link'));
    fs.writeFileSync(path.join(root, 'unknown-file'), 'x');
    fs.mkdirSync(path.join(root, '.removing-0190a000-0000-7000-8000-000000000000', 'left'), { recursive: true });

    await launchRuntime(stack.temp, { clock: createFakeClock(RUNTIME_MS) });

    const keptNames = [seeded.active, seeded.activeSymlink, seeded.recent, 'unknown-link', '.removing-0190a000-0000-7000-8000-000000000000'];
    const keptSidecars = [seeded.active, seeded.recent].map((id) => path.basename(sidecarOf(hostKernelLock(), path.join(root, id))));
    expect(fs.readdirSync(root).sort()).toEqual([...keptNames, ...keptSidecars].sort());
    expect(fs.lstatSync(path.join(root, seeded.activeSymlink)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(root, seeded.active, 'work', 'f'), 'utf8')).toBe('x');
    expect(fs.readdirSync(outside)).toEqual(['keep.txt']);
  });
});
