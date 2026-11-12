import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, TERMINAL_STATUSES } from '@momonga/protocol';
import { CLAIM_STATUSES, DEAD_LETTER_TRANSITIONS, SERVICE_TRANSITIONS, SWEEP_TRANSITIONS, WORKER_TRANSITIONS } from '@momonga/store';

const root = path.resolve(import.meta.dirname, '..');
const spec = fs.readFileSync(path.join(root, 'specs', 'tla', 'RunRecord.tla'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'packages', 'store', 'src', 'runtime-store.ts'), 'utf8');

const WAITING_STATUSES = ['WAITING_HUMAN', 'WAITING_TOOL'];

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name} ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in RunRecord.tla`);
  const blank = spec.indexOf('\n\n', start);
  const oneLine = /^\w+ == \{[^}]*\}$/m.exec(spec.slice(start));
  const end = oneLine === null ? blank : start + oneLine[0].length;
  return spec.slice(start, end === -1 ? undefined : end);
};

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const expand = (status: string): string[] => (status === 'WAITING' ? WAITING_STATUSES : [status]);

const tables: Array<Record<string, readonly string[]>> = [WORKER_TRANSITIONS, SERVICE_TRANSITIONS, SWEEP_TRANSITIONS, DEAD_LETTER_TRANSITIONS];

const inSomeTable = (from: string, to: string): boolean =>
  expand(from).some((source) => expand(to).some((target) => tables.some((table) => table[source]?.includes(target) === true)));

describe('RunRecord.tla against the implementation', () => {
  it('names exactly the terminal states of the protocol', () => {
    expect(stringsIn(definitionOf('Terminal')).sort()).toEqual([...TERMINAL_STATUSES].sort());
  });

  it('names exactly the statuses a claim can hold', () => {
    expect(stringsIn(definitionOf('ClaimSt')).sort()).toEqual([...CLAIM_STATUSES].sort());
  });

  const modelEdges = (): Array<readonly [string, string]> => [...definitionOf('DeclaredEdges').matchAll(/<<"(\w+)", "(\w+)">>/g)].map((match) => [match[1] as string, match[2] as string] as const);

  const collapse = (status: string): string => (WAITING_STATUSES.includes(status) ? 'WAITING' : status);

  const codeEdges = (): Array<readonly [string, string]> =>
    tables.flatMap((table) => Object.entries(table).flatMap(([from, targets]) => targets.map((to) => [collapse(from), collapse(to)] as const)));

  it('takes only status edges that a transition table of the store declares', () => {
    expect(modelEdges().length).toBeGreaterThan(0);
    expect(modelEdges().filter(([from, to]) => !inSomeTable(from, to))).toEqual([]);
  });

  it('declares in the transition tables of the store only status edges the model takes', () => {
    const declared = new Set(modelEdges().map(([from, to]) => `${from}->${to}`));
    expect([...new Set(codeEdges().map(([from, to]) => `${from}->${to}`))].filter((edge) => !declared.has(edge)).sort()).toEqual([]);
  });

  it('maps every event kind of the model to a protocol event type', () => {
    const mapped = stringsIn(definitionOf('ProtocolEvent'));
    const known: readonly string[] = EVENT_TYPES;
    expect(mapped).toContain('attempt.lost');
    expect(mapped.filter((type) => !known.includes(type))).toEqual([]);
  });

  it('ties Takeover of the model to the SQL predicate of the store and to the claim statement that counts a failed attempt', () => {
    expect(definitionOf('Takeover')).toMatch(/st \\in ClaimSt \/\\ owner # NoOwner/);
    expect(storeSource).toContain(`const TAKEOVER = "(r.status IN ('RUNNING', 'CANCELLING') AND r.lease_owner IS NOT NULL)";`);
    expect(storeSource).toMatch(/WHEN status IN \('RUNNING', 'CANCELLING'\) AND lease_owner IS NOT NULL THEN failed_attempts \+ 1/);
  });

  it('ties SweeperOwned of the model to the origins the store keeps out of claim', () => {
    expect(stringsIn(definitionOf('SweeperOwned')).sort()).toEqual(['CANCELLING', 'QUEUED', 'WAITING']);
    const predicate = /status = 'CANCELLING' AND (?:\w+\.)?cancel_origin IN \(([^)]*)\)/.exec(storeSource);
    const sqlOrigins = [...(predicate?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string);
    expect(sqlOrigins.map((origin) => (origin.startsWith('WAITING') ? 'WAITING' : origin)).filter((origin, index, all) => all.indexOf(origin) === index).sort()).toEqual(['QUEUED', 'WAITING']);
  });

  it('keeps the claim statement free of journal writes, so only the fixed design appends the takeover record in the claim transaction', () => {
    const claim = /claim: db\.prepare\(\s*`([^`]*)`/.exec(storeSource)?.[1] ?? '';
    expect(claim).toContain('UPDATE runs SET');
    expect(claim).not.toContain('INSERT INTO events');
  });
});
