import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { UninspectableProcess } from '../../src/platform/inspector-types.ts';
import { BOOT_TIME_RESOLUTION_MS, createLinuxInspector } from '../../src/platform/linux-inspector.ts';
import { nodeProcFs } from '../../src/platform/procfs.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SSH_AGENT = '/usr/bin/ssh-agent';
const PYTHON = '/usr/bin/python3';
const ON_LINUX = process.platform === 'linux';
const POLL_MS = 20;
const DEADLINE_MS = 20_000;
const OLDER_BY_MS = BOOT_TIME_RESOLUTION_MS + 500;
const ZOMBIE_LEADER = [
  'import ctypes, sys, threading, time',
  'held = open(sys.argv[1])',
  'threading.Thread(target=lambda: time.sleep(60)).start()',
  'open(sys.argv[2], "w").close()',
  'ctypes.CDLL(None).pthread_exit(None)',
].join('\n');

const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
};

describe.runIf(ON_LINUX)('the Linux inspector against real processes', () => {
  let directory = '';
  let children: ChildProcess[] = [];
  const inspector = () => createLinuxInspector({ procfs: nodeProcFs, uid: process.getuid?.() as number });

  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-inspect-')));
  });

  afterEach(() => {
    for (const child of children) child.kill('SIGKILL');
    children = [];
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const startAgent = async (): Promise<ChildProcess> => {
    const socket = path.join(directory, `agent-${children.length}.sock`);
    const agent = spawn(SSH_AGENT, ['-D', '-a', socket], { stdio: 'ignore' });
    children.push(agent);
    await until(() => fs.existsSync(socket), 'ssh-agent to listen');
    return agent;
  };

  const startHolder = async (marker: string): Promise<ChildProcess> => {
    const ready = `${marker}.ready`;
    const holder = spawn('/bin/sh', ['-c', `exec 3<${marker}; : > ${ready}; exec sleep 60`], { stdio: 'ignore' });
    children.push(holder);
    await until(() => fs.existsSync(ready), 'the holder to open the marker');
    return holder;
  };

  describe.runIf(fs.existsSync(SSH_AGENT))('with a real ssh-agent, which is non-dumpable and belongs to the current user', () => {
    it('refuses its descriptor directory, as the review assumed', async () => {
      const agent = await startAgent();
      await expect(fs.promises.readdir(`/proc/${agent.pid}/fd`)).rejects.toMatchObject({ code: 'EACCES' });
      expect(fs.readFileSync(`/proc/${agent.pid}/status`, 'utf8')).toMatch(new RegExp(`^Uid:\\s+${process.getuid?.()}\\s`, 'm'));
    });

    it('holds nothing when it started before the marker, so a marker probe succeeds at once', async () => {
      await startAgent();
      await new Promise((resolve) => setTimeout(resolve, OLDER_BY_MS));
      const marker = path.join(directory, 'marker');
      fs.writeFileSync(marker, '');
      const holder = await startHolder(marker);
      const started = Date.now();
      expect(await inspector().holdersOf(marker, { signal: new AbortController().signal })).toEqual({ kind: 'value', value: [holder.pid] });
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('is reported by pid and command, without failing the scan, when it started after the marker', async () => {
      const marker = path.join(directory, 'marker');
      fs.writeFileSync(marker, '');
      const agent = await startAgent();
      const holder = await startHolder(marker);
      const found: UninspectableProcess[] = [];
      expect(await inspector().holdersOf(marker, { signal: new AbortController().signal }, (process) => void found.push(process))).toEqual({ kind: 'value', value: [holder.pid] });
      expect(found).toEqual([{ pid: agent.pid, command: 'ssh-agent', startedAt: expect.any(Number) }]);
    });
  });

  describe.runIf(fs.existsSync(PYTHON))('with a real zombie thread-group leader whose thread still runs', () => {
    it('finds the marker held by the live thread', async () => {
      const marker = path.join(directory, 'marker');
      fs.writeFileSync(marker, '');
      const ready = path.join(directory, 'ready');
      const leader = spawn(PYTHON, ['-c', ZOMBIE_LEADER, marker, ready], { stdio: 'ignore' });
      children.push(leader);
      await until(() => fs.existsSync(ready), 'the leader to start its thread');
      await until(() => fs.readFileSync(`/proc/${leader.pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') === true, 'the leader to become a zombie');
      expect(await inspector().holdersOf(marker, { signal: new AbortController().signal })).toEqual({ kind: 'value', value: [leader.pid] });
    });
  });
});
