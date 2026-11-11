import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePolicyOverlay } from '@momonga/eval';

const POLICIES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'policies');

describe('a key the harness sets per case is refused in a policy overlay (DECISION-7)', () => {
  it('refuses context.autoCompact by name, because every case sets it from its own compaction field', () => {
    expect(() => parsePolicyOverlay(JSON.stringify({ context: { autoCompact: false } }), 'policy.json')).toThrow(/policy\.json: context\.autoCompact is set by the compaction field of each case/);
  });

  it('accepts the other core keys', () => {
    expect(parsePolicyOverlay(JSON.stringify({ context: { cachePrefix: false } }), 'policy.json')).toEqual({ context: { cachePrefix: false } });
  });

  it('every overlay shipped with the harness parses', () => {
    for (const name of fs.readdirSync(POLICIES)) expect(() => parsePolicyOverlay(fs.readFileSync(path.join(POLICIES, name), 'utf8'), name)).not.toThrow();
  });
});
