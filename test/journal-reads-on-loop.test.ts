import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(import.meta.dirname, '..', 'packages');

const sourcesOf = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'dist' ? [] : sourcesOf(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const relative = (file: string): string => path.relative(packagesDir, file).split(path.sep).join('/');

const filesMatching = (pattern: RegExp): string[] =>
  fs
    .readdirSync(packagesDir)
    .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
    .flatMap((name) => sourcesOf(path.join(packagesDir, name, 'src')).filter((file) => pattern.test(fs.readFileSync(file, 'utf8'))))
    .map(relative)
    .sort();

const PAYLOAD_SQL = /(json_extract|json_each|jsonb|json_tree|length)\(\s*(?:[a-z]\.)?payload_json/;

const MAIN_THREAD_STORE_FILES = ['store/src/runtime-store.ts', 'store/src/search.ts', 'store/src/memories.ts', 'store/src/append-records.ts'];

const payloadSqlLines = (file: string): string[] =>
  fs
    .readFileSync(path.join(packagesDir, file), 'utf8')
    .split('\n')
    .filter((line) => PAYLOAD_SQL.test(line))
    .map((line) => line.trim());

describe('statements that read inside payload_json on the main thread (section 7: SQL-side reads are invisible to onDecode)', () => {
  it('are only the classified ones: ids (row 16), anatomy (row 10) and called names (row 8b) are columns or records, and the indexed characters of a run add up one appended event at a time (row 12)', () => {
    expect(Object.fromEntries(MAIN_THREAD_STORE_FILES.map((file) => [file, payloadSqlLines(file)]))).toEqual({
      'store/src/runtime-store.ts': ["JOIN json_each(e.payload_json, '$.names') n"],
      'store/src/search.ts': [
        "WHERE e.id > :cursor AND e.type = 'run.status' AND json_extract(e.payload_json, '$.to') IN (${TERMINAL_LIST})",
        '`SELECT *, length(payload_json) AS payload_chars FROM events WHERE run_id = :runId AND seq >= :seqFrom AND seq <= :seqTo AND (:step IS NULL OR step = :step) ORDER BY seq LIMIT :limit`,',
      ],
      'store/src/memories.ts': [],
      'store/src/append-records.ts': [
        '`INSERT INTO run_indexed_chars (run_id, chars) SELECT :runId, length(payload_json) FROM events WHERE id = :eventId',
      ],
    });
  });

  it('search indexing reads the document kept at append and no event of the run: search.ts names payload_json in the two classified statements only (row 12, O9 option c)', () => {
    const naming = fs.readFileSync(path.join(packagesDir, 'store/src/search.ts'), 'utf8').split('\n').filter((line) => /payload_json/.test(line));
    expect(naming.map((line) => line.trim())).toEqual(payloadSqlLines('store/src/search.ts'));
  });

  it('the size probe of search indexing reads no payload: no statement of search.ts sums a length over the events of a run (row 12, O9)', () => {
    expect(payloadSqlLines('store/src/search.ts').filter((line) => /SUM\(/.test(line))).toEqual([]);
  });
});

describe('readers that answer from append-time records do not walk the journal on the main thread', () => {
  it('no worker step counts by scanning the run: countWhere and countRecorded are gone (row 5)', () => {
    expect(filesMatching(/\bcountWhere\b|\bcountRecorded\b/)).toEqual([]);
  });

  it('the seq of a tool call is not found by reading every event of the run (row 7)', () => {
    expect(filesMatching(/\bcallSeqOf\(store\b/)).toEqual([]);
    expect(filesMatching(/readAllRunEvents\([^)]*\)\.find\(/)).toEqual([]);
  });

  it('loop guidance does not read every tool.completed of the run (row 8c)', () => {
    expect(filesMatching(/readRunEventsOfTypes\([^)]*\['tool\.completed'\]/)).toEqual([]);
  });

  it('rendered forms do not read every truncation of the run (row 8e)', () => {
    expect(filesMatching(/readRunEventsOfTypes\([^)]*FORM_EVENT_TYPES/)).toEqual([]);
  });

  it('the meter is not restored from every meter.observed of every run of the session (row 8g)', () => {
    expect(filesMatching(/readRunEventsOfTypes\([^)]*\['meter\.observed'\]/)).toEqual([]);
  });

  it('the share window does not read the notices of each run (row 8i)', () => {
    expect(filesMatching(/readRunEventsOfTypes\([^)]*'notice'/)).toEqual([]);
  });

  it('arrivals do not re-read every instructions.loaded event at each build (row 21)', () => {
    expect(filesMatching(/readRunEventsOfTypes\([^)]*\['instructions\.loaded'\]/)).toEqual([]);
  });

  it('the run state of a claim is loaded by the journal thread: the store decodes no journal to load a run, and the worker writes no snapshot', () => {
    const runtimeStore = fs.readFileSync(path.join(packagesDir, 'store/src/runtime-store.ts'), 'utf8');
    expect(runtimeStore).not.toMatch(/\bloadInReadTx\b/);
    expect(filesMatching(/\bwriteSnapshot\(/)).toEqual([]);
  });

  it('inheritance neither folds the source nor decodes a copied context.inherited row on the main thread (row 11)', () => {
    const runtimeStore = fs.readFileSync(path.join(packagesDir, 'store/src/runtime-store.ts'), 'utf8');
    expect(runtimeStore).not.toMatch(/\bprojectInheritance\(/);
    expect(runtimeStore).not.toMatch(/\bfoldedRun\(/);
    expect(runtimeStore).not.toMatch(/\binheritedEventRow\b/);
    expect(runtimeStore).not.toMatch(/\bcarriedSkillsOf\(/);
    expect(filesMatching(/\bevent\.history\.length\b/)).toEqual([]);
  });
});
