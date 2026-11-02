import { describe, expect, it } from 'vitest';
import { harness, rawDb } from './helpers.ts';

describe('migration v6', () => {
  it('lets an approval row carry an elicitation and defaults existing rows to permission', () => {
    const { dbPath } = harness();
    const columns = rawDb(dbPath).prepare("SELECT name, \"notnull\" AS required, dflt_value AS fallback FROM pragma_table_info('approvals')").all();
    const byName = Object.fromEntries(columns.map((column) => [column['name'], column]));
    expect(byName['kind']).toMatchObject({ required: 1, fallback: "'permission'" });
    for (const name of ['server', 'requests_json', 'responses_json']) expect(byName[name]).toMatchObject({ required: 0 });
    const versions = rawDb(dbPath).prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row['version']));
    expect(versions).toContain(6);
  });
});
