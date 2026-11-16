import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const TLA_DIRECTORY = `${repoRoot}specs/tla`;

const isSpecificationInput = (name: string): boolean => name.endsWith('.tla') || name.endsWith('.cfg') || name.endsWith('.json');

const unkeyedEntriesOf = (entries: readonly fs.Dirent[]): string[] =>
  entries.filter((entry) => !entry.isFile() || !isSpecificationInput(entry.name)).map((entry) => entry.name).sort();

describe('the kinds of file in specs/tla, the inputs of the cached TLC results', () => {
  it('holds only modules, configurations and JSON inputs (the manifest and model inputs such as Handover.actors.json, each in the reuse key), so nothing TLC loads from the folder is outside the key', () => {
    expect(unkeyedEntriesOf(fs.readdirSync(TLA_DIRECTORY, { withFileTypes: true }))).toEqual([]);
  });

  it('finds a compiled module class added to a copy of the listing, and a folder', async () => {
    const copy = createTempRoot();
    for (const name of fs.readdirSync(TLA_DIRECTORY)) fs.writeFileSync(path.join(copy, name), '');
    fs.writeFileSync(path.join(copy, 'Module.class'), '');
    fs.mkdirSync(path.join(copy, 'states'));
    const found = unkeyedEntriesOf(fs.readdirSync(copy, { withFileTypes: true }));
    await removeTempRoot(copy);
    expect(found).toEqual(['Module.class', 'states']);
  });
});
