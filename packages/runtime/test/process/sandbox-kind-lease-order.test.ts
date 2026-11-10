import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'process', 'start-runtime-process.ts'), 'utf8');

const bodyOf = (name: string): string => {
  const start = source.indexOf(`${name}: async`);
  if (start < 0) throw new Error(`start-runtime-process.ts has no ${name} entry`);
  const end = source.indexOf('\n        },', start);
  return source.slice(start, end);
};

describe('the health sandbox kind is read from the leased object before the lease is released (design-settings-live 15.6)', () => {
  it('sandboxKind reads lease.value before lease.release()', () => {
    const body = bodyOf('sandboxKind');
    const read = body.indexOf('lease.value');
    const release = body.indexOf('lease.release()');
    expect(read, 'sandboxKind reads the leased value').toBeGreaterThan(-1);
    expect(release, 'sandboxKind releases its lease').toBeGreaterThan(-1);
    expect(read, 'the value is read while the lease is held').toBeLessThan(release);
  });
});
