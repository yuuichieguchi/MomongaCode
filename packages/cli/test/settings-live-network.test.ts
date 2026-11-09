import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processOutboundNetwork } from '../src/network.ts';
import { nodeFiles } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const homeWithProxy = (): { ports: CliPorts; writeProxy(proxy: string): void } => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-cli-live-net-'));
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

describe('S4 CLI network: the next outbound operation uses the network settings current at its start (design-settings-live 3.3, D4)', () => {
  it('an operation that starts after a network change gets the new proxy; the earlier operation kept the old one', async () => {
    const { ports, writeProxy } = homeWithProxy();
    writeProxy('http://proxy-before.corp:3128');
    const before = await processOutboundNetwork(ports);
    writeProxy('http://proxy-after.corp:3128');
    const after = await processOutboundNetwork(ports);
    expect(before.config.httpsProxy).toMatchObject({ value: 'http://proxy-before.corp:3128', source: 'network.httpsProxy' });
    expect(after.config.httpsProxy).toMatchObject({ value: 'http://proxy-after.corp:3128', source: 'network.httpsProxy' });
  });
});
