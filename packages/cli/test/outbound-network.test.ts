import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { MomongaPaths } from '@momonga/foundation';
import { IDENTITY_READ_TIMEOUT_MS } from '@momonga/gateway';
import { LOCAL_SERVER_CANDIDATES } from '@momonga/protocol';
import { detectModels } from '../src/commands/models.ts';
import { withIdentityReadFetch, withOutboundNetwork } from '../src/network.ts';
import { nodeFiles } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';

const READS_PER_ADDRESS = 2;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const portsWith = (written: string[]): CliPorts => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-cli-net-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return {
    home,
    env: {},
    files: nodeFiles,
    stdout: { write: (text: string) => void written.push(text) },
    stderr: { write: (text: string) => void written.push(text) },
  } as unknown as CliPorts;
};

const silentServer = async (): Promise<string> => {
  const server = http.createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe('the CLI network', () => {
  it('is resolved from the current settings for each outbound operation', async () => {
    const ports = portsWith([]);

    const first = await withOutboundNetwork(ports, new AbortController().signal, async (network) => network);
    const second = await withOutboundNetwork(ports, new AbortController().signal, async (network) => network);

    expect(first.config).toEqual({ caFiles: [] });
    expect(second.config).toEqual(first.config);
  });

  it('ends models detect against a server that accepts and never answers at the identity read bound, without an interrupt', { timeout: IDENTITY_READ_TIMEOUT_MS * READS_PER_ADDRESS * (LOCAL_SERVER_CANDIDATES.length + 1) }, async () => {
    const written: string[] = [];
    const ports = portsWith(written);
    const silent = await silentServer();

    const interrupt = new AbortController().signal;
    const code = await withIdentityReadFetch(ports, interrupt, (fetch) =>
      detectModels(ports, { settingsFile: path.join(ports.home, 'settings.json') } as unknown as MomongaPaths, { typed: [silent], json: true, interrupt, fetch }),
    );

    expect(code).toBe(0);
    const found = JSON.parse(written.join('')) as Array<{ baseUrl: string }>;
    expect(found.map((server) => server.baseUrl)).not.toContain(silent);
  });
});
