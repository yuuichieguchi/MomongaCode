import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createTransport, eventually, makeDir } from './raw-transport.ts';

const WRITE_THROUGH_MARKER = [
  "const fs = require('node:fs');",
  "let outcome = 'written';",
  "try { fs.writeSync(3, 'g0000000001\\n', 0); } catch (error) { outcome = error.code; }",
  'fs.writeFileSync(process.argv[1], outcome);',
  'setInterval(() => {}, 1 << 30);',
].join(' ');

describe('the marker descriptor the MCP stdio transport hands to its server', () => {
  it('is read-only: the server writing through fd 3 gets EBADF', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const root = makeDir();
    const dir = path.join(root, 'markers');
    fs.mkdirSync(dir, { mode: 0o700 });
    const outcomeFile = path.join(root, 'outcome');
    const transport = createTransport({ config: { command: process.execPath, args: ['-e', WRITE_THROUGH_MARKER, outcomeFile] }, markers: { dir, onWarning: () => undefined }, closeGraceMs: 200 });
    await transport.start();
    try {
      await eventually(() => fs.existsSync(outcomeFile) && fs.readFileSync(outcomeFile, 'utf8') !== '', 'the server to report its write');
      expect(fs.readFileSync(outcomeFile, 'utf8')).toBe('EBADF');
    } finally {
      await transport.close();
    }
  });
});
