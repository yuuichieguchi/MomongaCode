import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/schema.ts';
import { PREVIOUS_RELEASE } from '../../src/compat-baseline.ts';
import { migrationFormViolations } from '../../src/migration-form.ts';

const sqlOf = (version: number): string => {
  const migration = MIGRATIONS.find((candidate) => candidate.version === version);
  if (migration === undefined) throw new Error(`no migration ${version}`);
  return migration.sql;
};

describe('the static form check of a migration (H7, 11.2 rules 2 to 4)', () => {
  it.each([
    ['DROP TABLE old_things;', /drop/i],
    ['DROP INDEX things_by_name;', /drop/i],
    ['ALTER TABLE things DROP COLUMN name;', /drop/i],
    ['ALTER TABLE things RENAME TO stuff;', /rename/i],
    ['ALTER TABLE things RENAME COLUMN name TO title;', /rename/i],
    ['ALTER TABLE things ADD COLUMN size INTEGER NOT NULL;', /not null without a default/i],
    ["ALTER TABLE things ADD COLUMN size INTEGER CHECK (size > 0);", /check/i],
    ["ALTER TABLE things ADD COLUMN origin TEXT;\nCREATE TRIGGER things_need_origin BEFORE INSERT ON things WHEN NEW.origin IS NULL BEGIN\n  SELECT RAISE(ABORT, 'origin');\nEND;", /tighten/i],
  ])('refuses %j', (sql, reason) => {
    const violations = migrationFormViolations(sql);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('\n')).toMatch(reason);
  });

  it.each([
    'CREATE TABLE things (id INTEGER PRIMARY KEY, state TEXT NOT NULL CHECK (state IN (\'a\', \'b\')));',
    'CREATE INDEX things_by_state ON things (state);',
    'ALTER TABLE things ADD COLUMN size INTEGER;',
    'ALTER TABLE things ADD COLUMN size INTEGER NOT NULL DEFAULT 0;',
    "CREATE TRIGGER things_touch AFTER INSERT ON things BEGIN\n  INSERT INTO touched (id) VALUES (NEW.id);\nEND;",
  ])('accepts %j', (sql) => {
    expect(migrationFormViolations(sql)).toEqual([]);
  });

  it('splits a trigger written on one line from the statements after it', () => {
    expect(migrationFormViolations('CREATE TRIGGER things_touch AFTER INSERT ON things BEGIN INSERT INTO touched (id) VALUES (NEW.id); END;\nDROP TABLE old_things;').join('\n')).toMatch(/drop/i);
  });

  it('finds the banned forms in the release-1 migrations that have them', () => {
    expect(migrationFormViolations(sqlOf(2)).join('\n')).toMatch(/drop/i);
    expect(migrationFormViolations(sqlOf(19)).join('\n')).toMatch(/tighten/i);
    const v22 = migrationFormViolations(sqlOf(22)).join('\n');
    expect(v22).toMatch(/rename/i);
    expect(v22).toMatch(/drop/i);
    expect(v22).toMatch(/tighten/i);
  });

  describe.skipIf(PREVIOUS_RELEASE === undefined)('the migrations after the previous release', () => {
    it.each(MIGRATIONS.filter((migration) => PREVIOUS_RELEASE !== undefined && migration.version > PREVIOUS_RELEASE.lastMigration).map((migration) => [migration.version, migration] as const))(
      'version %i has only additive forms',
      (_version, migration) => {
        expect(migrationFormViolations(migration.sql)).toEqual([]);
      },
    );
  });
});
