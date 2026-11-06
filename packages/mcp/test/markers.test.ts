import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHolders } from '@momonga/foundation';
import { MCP_MODERN_SERVER_PATH, MODERN_FIXTURE_SETSID_GRANDCHILD_ENV, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createTransport, descriptorPath, eventually, groupExists, makeDir, pidAlive, rawConfig, startRaw, trackPid } from './raw-transport.ts';

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };
const SSH_AGENT = '/usr/bin/ssh-agent';
const AGENT_CLOSE_BOUND_MS = 4000;

const markerSetup = () => {
  const dir = path.join(makeDir(), 'markers');
  fs.mkdirSync(dir, { mode: 0o700 });
  const warnings: string[] = [];
  return { dir, warnings, markers: { dir, onWarning: (message: string) => void warnings.push(message) } };
};

const markerFiles = (dir: string): string[] => fs.readdirSync(dir).map((name) => path.join(dir, name));

describe('MCP stdio transport markers', () => {
  it('creates a 0600 marker before spawn, passes it as fd 3 and writes the pid', PROCESS_TIMEOUT, async () => {
    const { dir, markers } = markerSetup();
    const { transport, request } = await startRaw({ config: rawConfig(), markers });
    const { pid } = (await request('pid')) as { pid: number };

    const files = markerFiles(dir);
    expect(files).toHaveLength(1);
    const [marker] = files as [string];
    expect(path.basename(marker)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(marker, 'utf8')).toBe(`${pid}\n`);
    expect(transport.pgid).toBe(pid);
    expect(await descriptorPath(pid, 3)).toBe(fs.realpathSync(marker));
    expect(await findHolders(marker, { signal: new AbortController().signal })).toEqual([pid]);
  });

  it('removes the marker when the command cannot be resolved', async () => {
    const { dir, markers } = markerSetup();
    const transport = createTransport({ config: { command: 'mm-definitely-missing-command' }, baseEnv: { PATH: '/nonexistent-a' }, markers });

    await expect(transport.start()).rejects.toThrow(/not found in PATH/);

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('removes the marker when spawn fails', async () => {
    const { dir, markers } = markerSetup();
    const transport = createTransport({ config: rawConfig([], { cwd: 'missing-working-directory' }), markers });

    await expect(transport.start()).rejects.toThrow();

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a clean close removes the marker', PROCESS_TIMEOUT, async () => {
    const { dir, markers, warnings } = markerSetup();
    const { transport, request } = await startRaw({ config: rawConfig(), markers, closeGraceMs: 200 });
    const { pid } = (await request('pid')) as { pid: number };
    expect(markerFiles(dir)).toHaveLength(1);

    await transport.close();

    expect(fs.readdirSync(dir)).toEqual([]);
    expect(groupExists(pid)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('close sweeps a setsid grandchild that still holds the marker', PROCESS_TIMEOUT, async () => {
    const { dir, markers } = markerSetup();
    const readyFile = path.join(makeDir(), 'setsid.pid');
    const transport = createTransport({
      config: { command: process.execPath, args: [MCP_MODERN_SERVER_PATH], env: { [MODERN_FIXTURE_SETSID_GRANDCHILD_ENV]: readyFile } },
      markers,
      closeGraceMs: 200,
    });
    await transport.start();
    const leader = transport.pgid;
    if (leader === undefined) throw new Error('expected a server pid');
    expect(markerFiles(dir)).toHaveLength(1);
    await eventually(() => fs.existsSync(readyFile), 'the setsid grandchild to start');
    const grandchild = Number(fs.readFileSync(readyFile, 'utf8'));
    trackPid(grandchild);
    const [marker] = markerFiles(dir) as [string];
    await eventually(async () => (await findHolders(marker, { signal: new AbortController().signal })).includes(grandchild), 'the grandchild to hold the marker');

    await transport.close();

    expect(pidAlive(grandchild)).toBe(false);
    expect(groupExists(leader)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  describe.runIf(process.platform === 'linux' && fs.existsSync(SSH_AGENT))('with a real ssh-agent, which is non-dumpable and belongs to the current user', () => {
    it('close completes, names an agent that started after the marker as one that could not be inspected, and keeps the marker', PROCESS_TIMEOUT, async () => {
      const { dir, markers, warnings } = markerSetup();
      const { transport, request } = await startRaw({ config: rawConfig(), markers, closeGraceMs: 200 });
      const { pid } = (await request('pid')) as { pid: number };
      expect(markerFiles(dir)).toHaveLength(1);
      const socket = path.join(makeDir(), 'agent.sock');
      const agent = spawn(SSH_AGENT, ['-D', '-a', socket], { stdio: 'ignore' });
      if (agent.pid === undefined) throw new Error('ssh-agent did not start');
      trackPid(agent.pid);
      await eventually(() => fs.existsSync(socket), 'ssh-agent to listen');
      const [marker] = markerFiles(dir) as [string];

      const started = Date.now();
      await transport.close();

      expect(Date.now() - started).toBeLessThan(AGENT_CLOSE_BOUND_MS);
      expect(groupExists(pid)).toBe(false);
      expect(fs.existsSync(marker)).toBe(true);
      expect(warnings).toEqual([`mcp marker ${marker}: process ${agent.pid} (ssh-agent) could not be inspected, so it was left alone`]);
    });
  });

  it('a server that exits on its own has its marker removed', PROCESS_TIMEOUT, async () => {
    const { dir, markers } = markerSetup();
    const { transport, closes } = await startRaw({ config: rawConfig(), markers, closeGraceMs: 200 });
    expect(markerFiles(dir)).toHaveLength(1);

    await transport.send({ jsonrpc: '2.0', id: 1, method: 'exit', params: { code: 0 } });
    await eventually(() => closes() === 1, 'the transport to close after the server exited');

    await eventually(() => fs.readdirSync(dir).length === 0, 'the marker to be removed');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('without markers there is no fd 3 and no marker file', PROCESS_TIMEOUT, async () => {
    const parent = makeDir();
    const transport = createTransport({ config: { command: '/bin/sleep', args: ['30'] }, projectDir: parent, closeGraceMs: 200 });
    await transport.start();
    const pid = transport.pgid;
    if (pid === undefined) throw new Error('expected a server pid');

    expect(await descriptorPath(pid, 3)).toBeUndefined();
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('with markers a server that never touches fd 3 still holds the marker as fd 3', PROCESS_TIMEOUT, async () => {
    const { dir, markers } = markerSetup();
    const transport = createTransport({ config: { command: '/bin/sleep', args: ['30'] }, markers, closeGraceMs: 200 });
    await transport.start();
    const pid = transport.pgid;
    if (pid === undefined) throw new Error('expected a server pid');

    const [marker] = markerFiles(dir) as [string];
    expect(marker).toBeDefined();
    expect(await descriptorPath(pid, 3)).toBe(fs.realpathSync(marker));
    expect(fs.readFileSync(marker, 'utf8')).toBe(`${pid}\n`);
  });
});
