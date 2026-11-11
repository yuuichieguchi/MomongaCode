import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemTiming, ensureMomongaDirs } from '@momonga/foundation';
import { loadUserModels } from '@momonga/config';
import { momongaPaths } from '@momonga/foundation';
import { NotAProbeableModel, probeModel } from '../src/commands/gateway.ts';
import { copyProbeRecord } from '../src/eval/context-effects.ts';
import { withOutboundNetwork } from '../src/network.ts';
import { nodeFiles } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const temporary = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-decl-')));
  roots.push(dir);
  return dir;
};

const declaredHome = (command: string): string => {
  const home = temporary();
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(home, '.momonga', 'settings.json'),
    JSON.stringify({
      models: {
        servers: { loom: { command, args: ['run', '--socket', '{socket}'], readyPath: '/ready' } },
        connections: [{ adapter: 'managed', server: 'loom', models: [{ id: 'fake-1' }] }],
      },
    }),
    { mode: 0o600 },
  );
  return home;
};

const sink = () => {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => (chunks.push(chunk), true) };
};

describe('the CLI readers resolve a declared server through the registry of the loaded settings (design-managed-servers 19.12, 19.14 item 4; R-S19-24)', () => {
  it('gateway probe (R8, gateway.ts) treats a model of a declared server as probeable and reaches its row-0 check', async () => {
    const missing = path.join(temporary(), 'absent-server');
    const home = declaredHome(missing);
    const ports = { home, env: {}, stdout: sink(), stderr: sink(), files: nodeFiles } as unknown as CliPorts;
    const paths = momongaPaths(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const error = await probeModel(ports, paths, 'fake-1', { interrupt: AbortSignal.timeout(30_000) }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotAProbeableModel);
    expect((error as Error).message).toContain(`the executable was not found at ${missing}`);
  });

  it('the eval record copy (R8, context-effects.ts) resolves a declared server through the registry its caller loaded, and copies nothing when it was never probed (19.14 item 16a)', async () => {
    const binary = path.join(temporary(), 'loom-server');
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
    const home = declaredHome(binary);
    const from = momongaPaths(home, process.platform, {}).probe;
    const to = path.join(temporary(), 'probe');
    const servers = (await loadUserModels({ home, signal: new AbortController().signal })).resolved.servers;
    if (servers === undefined) throw new Error('the loaded settings carry no server registry');
    expect(await copyProbeRecord(nodeFiles, from, to, { model: 'loom/fake-1', server: 'loom', binary, upstream: 'fake-1' }, servers, process.platform, AbortSignal.timeout(30_000))).toBe(false);
    expect(fs.existsSync(to)).toBe(false);
  });

  it('the outbound network reader (R13, network.ts) loads settings that declare a server', async () => {
    const home = declaredHome('/opt/loom/bin/loom-server');
    const ports = { home, env: {}, timers: systemTiming, stderr: sink(), files: nodeFiles } as unknown as CliPorts;
    await expect(withOutboundNetwork(ports, new AbortController().signal, async (network) => network)).resolves.toMatchObject({ config: expect.anything() });
  });
});
