import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReplayAdapter } from '@momonga/gateway';
import type { AdapterRequest } from '@momonga/protocol';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { makeDir, userInput } from './gateway-helpers.ts';

const ctx = { signal: new AbortController().signal, target: { name: 'primary', model: 'm' }, attempt: 1 };
const request: AdapterRequest = { model: 'm', input: userInput('q') };

const record = async (file: string): Promise<void> => {
  const inner = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'm', chunks: ['x'] }) }] });
  for await (const event of createReplayAdapter({ path: file, mode: 'record', inner }).create(request, ctx)) void event;
};

describe('recording directory', () => {
  it('creates only the leaf recording directory with mode 0700', async () => {
    const parent = makeDir();
    const leaf = path.join(parent, 'recordings');
    await record(path.join(leaf, 'r.jsonl'));
    expect(fs.statSync(leaf).mode & 0o777).toBe(0o700);
  });

  it('refuses to create intermediate directories and names the missing parent', () => {
    const missingParent = path.join(makeDir(), 'absent');
    const inner = createScriptedAdapter({ calls: [] });
    expect(() => createReplayAdapter({ path: path.join(missingParent, 'recordings', 'r.jsonl'), mode: 'record', inner })).toThrow(
      new RegExp(missingParent.replaceAll('/', '\\/')),
    );
    expect(fs.existsSync(missingParent)).toBe(false);
  });

  it('refuses an existing parent directory that is not 0700', () => {
    const parent = makeDir();
    fs.chmodSync(parent, 0o755);
    const inner = createScriptedAdapter({ calls: [] });
    expect(() => createReplayAdapter({ path: path.join(parent, 'r.jsonl'), mode: 'record', inner })).toThrow(/0700/);
  });
});
