import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { nodeFiles } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { nodeUpdatePorts } from '../src/update/node-ports.ts';

const RELEASE_HOST = 'release.example.test';
const TEST_TIMEOUT_MS = 10_000;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const startForwardingProxy = async (): Promise<{ port: number; seen: string[] }> => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ tag_name: 'v1.0.0' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, seen };
};

describe('the update ports of the CLI', { timeout: TEST_TIMEOUT_MS }, () => {
  it('take the network section of the user settings, so the update download goes through the configured proxy', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-update-wiring-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const proxy = await startForwardingProxy();
    const paths = momongaLayout(home);
    fs.mkdirSync(path.dirname(paths.settingsFile), { recursive: true });
    fs.writeFileSync(paths.settingsFile, JSON.stringify({ network: { httpProxy: `http://127.0.0.1:${proxy.port}` } }));
    const written: string[] = [];
    const ports = {
      home,
      env: {},
      files: nodeFiles,
      version: '1.0.0',
      platform: process.platform,
      stdout: { write: (text: string) => void written.push(text) },
      stderr: { write: (text: string) => void written.push(text) },
    } as unknown as CliPorts;
    const url = `http://${RELEASE_HOST}/repos/acme/momonga/releases/latest`;

    const response = await nodeUpdatePorts(ports, paths).http.get(url, { headers: {}, signal: new AbortController().signal });
    let body = '';
    for await (const chunk of response.body) body += Buffer.from(chunk).toString('utf8');

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ tag_name: 'v1.0.0' });
    expect(proxy.seen).toEqual([`GET ${url}`]);
  });
});
