import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { STOP_REASONS } from '@momonga/protocol';
import { projectInheritance } from '@momonga/store';
import { MIGRATIONS } from '../src/schema.ts';
import { claimed, closureEntry, ended, foldOf, task, requested, responded, callItem, toolCall } from './inherit-fixtures.ts';
import type { InheritedEvent } from './inherit-fixtures.ts';
import { makeStoreDir, UNASKED_COMMANDS } from './helpers.ts';

const USAGE_LIMIT_CLOSURE = 'Not run: the previous request stopped because the usage allowance was reached before this tool call ran.';

const runsCheckList = (): string[] => {
  const db = new DatabaseSync(path.join(makeStoreDir(), 'runtime.db'));
  try {
    migrate(db, MIGRATIONS);
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get() as { sql: string };
    const match = /stop_reason\s+IN\s*\(([^)]*)\)/.exec(row.sql);
    if (match === null) throw new Error('runs has no stop_reason CHECK list');
    return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1] as string);
  } finally {
    db.close();
  }
};

describe('runs.stop_reason accepts usage_limit after migration 29 (P3c, M7 storage, G11)', () => {
  it('has a migration 29 and a CHECK list that is a superset of STOP_REASONS, usage_limit and conditions_unmet included', () => {
    expect(MIGRATIONS.some((migration) => migration.version === 29)).toBe(true);
    const allowed = runsCheckList();
    for (const reason of STOP_REASONS) expect(allowed).toContain(reason);
    expect(allowed).toContain('usage_limit');
    expect(allowed).toContain('conditions_unmet');
  });
});

describe('a call left open by a usage stop is closed with its own text (P3c, inherit.ts)', () => {
  it('closes the dangling call with the usage-allowance sentence', () => {
    const state = foldOf([task('Write it'), ...claimed('manual'), requested(1), responded(1, [callItem('c1')]), toolCall('c1'), ended('STOPPED', 'usage_limit')]);
    const payload = projectInheritance(state, { status: 'STOPPED', stopReason: 'usage_limit' as never }, { kind: 'final', currentMode: 'manual', unasked: UNASKED_COMMANDS }) as InheritedEvent;
    expect(payload.history.at(-1)).toEqual(closureEntry(payload.history.length, 'c1', USAGE_LIMIT_CLOSURE));
  });
});
