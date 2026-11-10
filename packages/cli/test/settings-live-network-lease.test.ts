import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OutboundNetwork } from '@momonga/foundation';
import * as network from '../src/network.ts';
import { nodeFiles } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';

type WithOutboundNetwork = <T>(ports: CliPorts, signal: AbortSignal, use: (network: OutboundNetwork) => Promise<T>) => Promise<T>;

const withOutboundNetwork: WithOutboundNetwork = (ports, signal, use) => {
  const exported = (network as Record<string, unknown>)['withOutboundNetwork'];
  if (typeof exported !== 'function') throw new Error('packages/cli/src/network.ts does not export withOutboundNetwork(ports, signal, use)');
  return (exported as WithOutboundNetwork)(ports, signal, use);
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const homeWithProxy = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-cli-lease-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let writes = 0;
  const writeProxy = (proxy: string): void => {
    writes += 1;
    const temporary = path.join(root, `.settings-${writes}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify({ network: { httpsProxy: proxy } })}${' '.repeat(writes)}`, { mode: 0o600 });
    fs.renameSync(temporary, path.join(root, 'settings.json'));
  };
  const ports = { home, env: {}, files: nodeFiles, stdout: { write: () => undefined }, stderr: { write: () => undefined } } as unknown as CliPorts;
  return { ports, writeProxy };
};

describe('S4 CLI network: one lease for the whole outbound operation, waited under its signal (design-settings-live 15.6)', () => {
  it('an operation whose signal is already aborted is refused with that reason and never uses the network', async () => {
    const { ports, writeProxy } = homeWithProxy();
    writeProxy('http://proxy-a.corp:3128');
    const controller = new AbortController();
    const reason = new Error('the command was interrupted');
    controller.abort(reason);
    let used = false;
    await expect(
      withOutboundNetwork(ports, controller.signal, async () => {
        used = true;
      }),
    ).rejects.toBe(reason);
    expect(used).toBe(false);
  });

  it('an operation keeps the network it started with while a later operation gets the changed one', async () => {
    const { ports, writeProxy } = homeWithProxy();
    writeProxy('http://proxy-a.corp:3128');
    const seen: string[] = [];
    await withOutboundNetwork(ports, new AbortController().signal, async (first) => {
      writeProxy('http://proxy-bb.corp:3128');
      await withOutboundNetwork(ports, new AbortController().signal, async (second) => {
        seen.push(String(second.config.httpsProxy?.value));
      });
      seen.push(String(first.config.httpsProxy?.value));
    });
    expect(seen).toEqual(['http://proxy-bb.corp:3128', 'http://proxy-a.corp:3128']);
  });
});
