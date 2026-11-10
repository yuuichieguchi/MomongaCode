import { execFile } from '@momonga/testkit/child-process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, generationLayout, momongaLayout } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { HAS_REAL_SANDBOX } from '../helpers.ts';
import { makeBuiltins, resultOf } from './fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe.runIf(HAS_REAL_SANDBOX && process.platform === 'darwin')('T17 (d) a sandboxed Bash command cannot reach the runtime socket that serves /markers ignore', () => {
  it('a curl to POST /v1/markers/:name/ignore over the runtime socket never connects', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const socket = generationLayout(tools.layout.home, FIRST_GENERATION).sockets.runtime;
    const socketDir = path.dirname(socket);
    const socketName = path.basename(socket);
    const cwd = process.cwd();
    fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
    expect(fs.existsSync('/usr/bin/curl')).toBe(true);
    let connections = 0;
    const server = net.createServer((connection) => {
      connections += 1;
      connection.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n');
    });
    process.chdir(socketDir);
    try {
      await new Promise<void>((resolve) => server.listen(socketName, resolve));
    } finally {
      process.chdir(cwd);
    }
    const started = Date.now();
    try {
      const result = resultOf(await tools.run('Bash', { command: `cd ${socketDir} && /usr/bin/curl -s -m 5 --unix-socket ${socketName} -X POST http://localhost/v1/markers/${'a'.repeat(64)}/ignore; echo "exit:$?"` }, {}, 'allow_once', 'reach'));
      expect({ ms: Date.now() - started < 20_000, output: result.output }).toMatchObject({ ms: true });
      expect(result.output).toMatch(/exit:[1-9]/);
      expect(result.output).not.toContain('HTTP');
      expect(connections).toBe(0);
      const control = await promisify(execFile)('/bin/sh', ['-c', `cd ${socketDir} && /usr/bin/curl -s -m 5 --unix-socket ${socketName} -X POST http://localhost/v1/markers/x/ignore; echo exit:$?`]);
      expect(control.stdout).toContain('exit:0');
      expect(connections).toBe(1);
    } finally {
      server.close();
    }
  });
});
