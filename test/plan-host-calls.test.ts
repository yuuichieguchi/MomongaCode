import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

const SCANNED = [path.join('packages', 'gateway', 'src', 'plan'), path.join('packages', 'foundation', 'src', 'encrypted-credential-store.ts')];

const HOST_RANDOM = [/\bMath\.random\b/, /\bpromisify\(\s*randomBytes\s*\)/];

const filesUnder = (relative: string): string[] => {
  const absolute = path.join(ROOT, relative);
  if (fs.statSync(absolute).isFile()) return [relative];
  return fs
    .readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => path.join(relative, name))
    .sort();
};

describe('O-R5-6 L8: the plan files take their random through a port', () => {
  it('no Math.random and no promisify(randomBytes) in gateway/src/plan and foundation/src/encrypted-credential-store.ts', () => {
    const found = SCANNED.flatMap(filesUnder).flatMap((file) =>
      fs
        .readFileSync(path.join(ROOT, file), 'utf8')
        .split('\n')
        .flatMap((line, index) => (HOST_RANDOM.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
