import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = path.resolve(import.meta.dirname, '../src');

describe('packages/mcp/src', () => {
  it('never reads process.env', () => {
    const offenders = fs
      .readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /process\.env\b/.test(fs.readFileSync(path.join(srcDir, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('contains the stdio transport module', () => {
    expect(fs.existsSync(path.join(srcDir, 'stdio-transport.ts'))).toBe(true);
  });
});
