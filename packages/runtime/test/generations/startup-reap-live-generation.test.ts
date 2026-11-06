import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { acquireProcessLock, ensureMomongaDirs } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { onCleanup, trackGroup } from '../process/helpers.ts';
import { launchRuntime, prepareStack, stepsLogged } from '../process/run-helpers.ts';

type GenerationScope = (paths: MomongaPaths, generation: number) => MomongaPaths;

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

const scopeToGeneration = (): GenerationScope => {
  const value = (foundation as Record<string, unknown>)['scopeToGeneration'];
  if (typeof value !== 'function') throw new Error('@momonga/foundation does not export scopeToGeneration');
  return value as GenerationScope;
};

const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const spawnMarkedHolder = (marker: string): number => {
  const fd = fs.openSync(marker, 'w', 0o600);
  let pid: number | undefined;
  try {
    pid = spawn('/bin/sh', ['-c', 'exec sleep 30'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] }).pid;
    if (pid !== undefined) fs.writeSync(fd, `${pid}\n`);
  } finally {
    fs.closeSync(fd);
  }
  if (pid === undefined) throw new Error('the marker holder did not spawn');
  trackGroup(pid);
  return pid;
};

const holdSupervisorLock = async (lockPath: string): Promise<void> => {
  const lock = await acquireProcessLock(lockPath);
  onCleanup(() => lock.release());
};

describe('H3: start-up reaping never kills the children of a live generation', () => {
  it('leaves the MCP server marked by a generation whose supervisor still holds its lock', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    const paths = stack.temp.paths;
    await ensureMomongaDirs(paths);
    await holdSupervisorLock(paths.locks.supervisor);
    const liveServer = spawnMarkedHolder(`${paths.markers.mcp}/fx-live-generation`);
    const launched = await launchRuntime(stack.temp);
    expect(stepsLogged(launched.logger)).toContain('mcp-markers');
    expect(groupExists(liveServer)).toBe(true);
  });

  it('reaps the markers of a dead generation and keeps those of a live one when generation 3 starts', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    const scope = scopeToGeneration();
    const dead = scope(stack.temp.paths, 1);
    const live = scope(stack.temp.paths, 2);
    await ensureMomongaDirs(stack.temp.paths);
    for (const generation of [dead, live]) {
      fs.mkdirSync(generation.markers.mcp, { recursive: true, mode: 0o700 });
      fs.mkdirSync(generation.markers.tools, { recursive: true, mode: 0o700 });
      fs.mkdirSync(generation.callLocks, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(generation.locks.supervisor), { recursive: true, mode: 0o700 });
    }
    await holdSupervisorLock(live.locks.supervisor);
    const deadServer = spawnMarkedHolder(`${dead.markers.mcp}/fx-dead-generation`);
    const liveServer = spawnMarkedHolder(`${live.markers.mcp}/fx-live-generation`);
    const liveCallLock = `${live.callLocks}/held-by-live-generation`;
    fs.writeFileSync(liveCallLock, '');
    const launched = await launchRuntime(stack.temp, { generation: 3 } as Parameters<typeof launchRuntime>[1]);
    expect(stepsLogged(launched.logger)).toContain('mcp-markers');
    expect(groupExists(deadServer)).toBe(false);
    expect(fs.existsSync(`${dead.markers.mcp}/fx-dead-generation`)).toBe(false);
    expect(groupExists(liveServer)).toBe(true);
    expect(fs.existsSync(`${live.markers.mcp}/fx-live-generation`)).toBe(true);
    expect(fs.existsSync(liveCallLock)).toBe(true);
  });
});
