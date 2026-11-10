import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

const STARTS = [
  'packages/gateway/src/process.ts',
  'packages/runtime/src/process/start-runtime-process.ts',
] as const;

const installTrustCalls = (source: string): string[] => {
  const calls: string[] = [];
  const pattern = /\binstallTrust\(/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') depth -= 1;
      if (depth === 0) break;
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
};

describe('a gateway or runtime start reads the trust store under its own start signal', () => {
  it.each(STARTS)('%s passes its start signal to installTrust and adds no timer of its own', (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const calls = installTrustCalls(source);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\{[^}]*\bsignal\b[^}]*\}\s*\)$/);
    expect(calls[0]).not.toMatch(/HOST_READ_BOUND_MS|AbortSignal\.timeout|setTimeout/);
    expect(source).not.toMatch(/\bHOST_READ_BOUND_MS\b/);
  });
});
