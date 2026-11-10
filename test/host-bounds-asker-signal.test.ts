import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');

const sourceFiles = (): string[] =>
  fs
    .readdirSync(PACKAGES)
    .flatMap((name) => {
      const src = path.join(PACKAGES, name, 'src');
      if (!fs.existsSync(src)) return [];
      return fs.readdirSync(src, { recursive: true, encoding: 'utf8' }).map((entry) => path.join(src, entry));
    })
    .filter((file) => /\.tsx?$/.test(file));

const offenders = (pattern: RegExp, allowed: readonly string[] = []): string[] =>
  sourceFiles()
    .map((file) => path.relative(ROOT, file))
    .filter((file) => !allowed.includes(file) && pattern.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));

describe('a bound that guards a host operation belongs to the operation that asked', () => {
  it('bounds no read with the start bound of the processes outside the start contract', () => {
    expect(offenders(/AbortSignal\.timeout\(\s*STARTUP_TIMEOUT_MS\s*\)/, ['packages/foundation/src/process-contract.ts'])).toEqual([]);
  });

  it('names the limit of a request to the runtime in the client', () => {
    expect(fs.readFileSync(path.join(PACKAGES, 'cli/src/client/runtime-client.ts'), 'utf8')).toMatch(/createUdsClient\(options\.resolveSocket,\s*\{\s*headersTimeoutMs:\s*HOST_READ_BOUND_MS\s*\}\)/);
  });
});

describe('whether a socket path fits is measured by a bind, never read from a table of platform numbers', () => {
  it('keeps no per-platform socket path limit in the product or the testkit', () => {
    expect(offenders(/\bsocketPathLimit\b|\bSOCKET_PATH_LIMIT\b|\bLINUX_SOCKET_PATH_LIMIT\b/)).toEqual([]);
  });
});
