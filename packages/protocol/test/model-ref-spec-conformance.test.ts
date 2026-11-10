import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayOf, resolveStoredModelRef, resolveTypedModelRef, storedModelRef, typedModelText } from '../src/index.ts';
import { view } from './model-ref-fixtures.ts';
import type { View } from './model-ref-fixtures.ts';

type Segments = string[];
type SpecOutcome = { k: 'missing' } | { k: 'ambiguous' } | { k: 'found'; prov: string; id: Segments };
type SpecRow = {
  settings: { conns: string[]; models: Record<string, Segments[]> };
  typed: { text: Segments; outcome: SpecOutcome }[];
  stored: { text: Segments; outcome: SpecOutcome }[];
  display: { prov: string; id: Segments; text: Segments }[];
};
type SpecTable = { defaultTag: Record<string, boolean>; rows: SpecRow[] };

const SPEC_TAG = 'latest';
const ROWS = 32;

const tableOf = (file: string): SpecTable => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../specs/tla', file), 'utf8')) as SpecTable;

const textOf = (segments: Segments): string => segments.join('/');

const viewsOf = (table: SpecTable, row: SpecRow): View[] =>
  row.settings.conns.flatMap((provider) => (row.settings.models[provider] ?? []).map((id) => view(provider, textOf(id), table.defaultTag[provider] === true ? SPEC_TAG : undefined)));

const canonOfOutcome = (outcome: SpecOutcome): string => (outcome.k === 'found' ? `${outcome.prov}/${textOf(outcome.id)}` : outcome.k);

const typedOf = (text: string, views: readonly View[]): string => {
  const resolution = resolveTypedModelRef(typedModelText(text), views);
  if (resolution.kind === 'found') return resolution.model.canon;
  return resolution.kind === 'ambiguous' ? 'ambiguous' : 'missing';
};

const storedOf = (text: string, views: readonly View[]): string => resolveStoredModelRef(storedModelRef(text), views)?.canon ?? 'missing';

const expectConforms = (file: string): void => {
  const table = tableOf(file);
  expect(table.defaultTag).toEqual({ p1: true, p2: false });
  expect(table.rows).toHaveLength(ROWS);
  table.rows.forEach((row, index) => {
    const views = viewsOf(table, row);
    const where = `${file} row ${index}`;
    expect(Object.fromEntries(row.typed.map((entry) => [textOf(entry.text), typedOf(textOf(entry.text), views)])), `${where} typed`).toEqual(
      Object.fromEntries(row.typed.map((entry) => [textOf(entry.text), canonOfOutcome(entry.outcome)])),
    );
    expect(Object.fromEntries(row.stored.map((entry) => [textOf(entry.text), storedOf(textOf(entry.text), views)])), `${where} stored`).toEqual(
      Object.fromEntries(row.stored.map((entry) => [textOf(entry.text), canonOfOutcome(entry.outcome)])),
    );
    expect(Object.fromEntries(views.map((entry) => [entry.canon, displayOf(entry, views)])), `${where} display`).toEqual(
      Object.fromEntries(row.display.map((entry) => [`${entry.prov}/${textOf(entry.id)}`, textOf(entry.text)])),
    );
  });
};

describe('the resolvers and the display function give what ModelRef.tla gives', () => {
  it('over the table of ModelRef.cfg (tagged own names, one server with a default tag)', () => {
    expectConforms('ModelRef.table.json');
  });

  it('over the table of ModelRef.slashTag.cfg (own names with a slash and with a tag)', () => {
    expectConforms('ModelRef.slash.table.json');
  });
});
