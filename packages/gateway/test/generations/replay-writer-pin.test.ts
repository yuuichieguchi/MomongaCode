import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (name: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', name), 'utf8');

describe('the product gateway writes no replay recording (design-update 18.3)', () => {
  it.each(['process.ts', 'entry.ts', 'bin.ts'])('%s does not import the replay adapter', (name) => {
    expect(source(name)).not.toContain('replay-adapter');
  });
});
