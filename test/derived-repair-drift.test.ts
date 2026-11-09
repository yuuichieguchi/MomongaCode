import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DERIVATIONS, DERIVED_VALUES } from '../packages/store/src/derived-repair.ts';

const root = path.resolve(import.meta.dirname, '..');
const spec = fs.readFileSync(path.join(root, 'specs', 'tla', 'DerivedRepair.tla'), 'utf8');
const config = fs.readFileSync(path.join(root, 'specs', 'tla', 'DerivedRepair.cfg'), 'utf8');
const storeSource = path.join(root, 'packages', 'store', 'src');

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in DerivedRepair.tla`);
  const end = spec.indexOf('\n', start);
  return spec.slice(start, end);
};

const constantOf = (name: string): string => {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, 'm').exec(config);
  if (match?.[1] === undefined) throw new Error(`${name} is not set in DerivedRepair.cfg`);
  return match[1];
};

const DERIVED_TABLES = ['run_records', 'started_calls', 'meter_records', 'session_touched', 'run_answerers', 'derived_through'];
const DERIVED_EVENT_COLUMNS = ['pinned_digest', 'call_id', 'approval_id', 'tool_name', 'notice_code', 'model_call_json'];
const DERIVATION_FILES = ['append-records.ts', 'derived-repair.ts', 'schema.ts'];

const sqlLiteralsOf = (source: string): string[] => [...source.matchAll(/(`[^`]*`|"[^"\n]*"|'[^'\n]*')/g)].map((match) => match[1] as string);

const readsDerivedData = (literal: string): boolean => {
  if (/^.\s*INSERT INTO events\b/.test(literal)) return false;
  if (DERIVED_TABLES.some((table) => new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`).test(literal))) return true;
  return /\bFROM events\b/.test(literal) && DERIVED_EVENT_COLUMNS.some((column) => new RegExp(`\\b${column}\\b`).test(literal));
};

describe('the store derivations against DerivedRepair.tla (H7, 11.5 correction)', () => {
  it('every scope a derivation holds is a value scope of the model, and the model has no scope the code lacks', () => {
    const modelScopes = new Set([...definitionOf('ValScope').matchAll(/"(run|session)"/g)].map((match) => match[1]));
    expect(new Set(DERIVED_VALUES.map((value) => value.scope))).toEqual(modelScopes);
  });

  it('every derivation holds at least one value, and every value belongs to a derivation', () => {
    expect([...new Set(DERIVED_VALUES.map((value) => value.derivation))].sort()).toEqual([...DERIVATIONS].sort());
  });

  it('the checked configuration is the form the code builds: a run watermark, a set-valued session derivation, the read with its tail, a page per transaction', () => {
    expect(constantOf('DsUnit')).toBe('run');
    expect(constantOf('DsKind')).toBe('set');
    expect(constantOf('ReadRule')).toBe('tail');
    expect(constantOf('Repair')).toBe('pageTx');
    const schema = fs.readFileSync(path.join(storeSource, 'schema.ts'), 'utf8');
    expect(schema).toMatch(/CREATE TABLE derived_through \(\s*run_id TEXT NOT NULL REFERENCES runs \(id\),\s*derivation INTEGER NOT NULL,\s*through_seq INTEGER NOT NULL,\s*PRIMARY KEY \(run_id, derivation\)/);
  });

  it('every statement that reads derived data lives with the derivations, so a reader cannot bypass the one read function', () => {
    const outside = fs
      .readdirSync(storeSource)
      .filter((file) => file.endsWith('.ts') && !DERIVATION_FILES.includes(file))
      .flatMap((file) => sqlLiteralsOf(fs.readFileSync(path.join(storeSource, file), 'utf8')).filter(readsDerivedData).map((literal) => `${file}: ${literal.slice(0, 120)}`));
    expect(outside).toEqual([]);
  });

  it('every read of an append-time record in the runtime store goes through the read function', () => {
    const source = fs.readFileSync(path.join(storeSource, 'runtime-store.ts'), 'utf8');
    const bypassing = source
      .split('\n')
      .filter((line) => /\brecords\.(?!record\b|recordFor\b)\w+\(/.test(line) && !/derivedReads\.read\(/.test(line));
    expect(bypassing).toEqual([]);
  });
});
