import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadUserModels } from '@momonga/config';
import { liveSettingsFor } from '../src/eval/context-host.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const scratchHome = (settings: unknown): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-live-')));
  roots.push(home);
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  return home;
};

const LOOM = { command: '/opt/loom/bin/loom-server', args: ['run', '--socket', '{socket}'], readyPath: '/ready' };
const KILN = { command: '/opt/kiln/bin/kiln-server', args: ['{socket}'], readyPath: '/health' };

const USER_SETTINGS = {
  models: {
    servers: { loom: LOOM, kiln: KILN },
    connections: [
      { adapter: 'managed', server: 'loom', models: [{ id: 'fake-1' }] },
      { adapter: 'managed', server: 'kiln', models: [{ id: 'fake-2' }] },
    ],
  },
};

describe('the eval scratch home carries the declaration of each server a copied model is served by (design-managed-servers 19.12; R-S19-25)', () => {
  it('copies the loom declaration for the model of loom, and not the kiln one no copied model is served by', async () => {
    const live = liveSettingsFor(await loadUserModels({ home: scratchHome(USER_SETTINGS), signal: new AbortController().signal }), ['loom/fake-1']);
    expect(live.models.servers).toEqual({ loom: LOOM });
    expect(live.operations.map((operation) => operation.kind)).toEqual(['declareServer', 'addModel', 'setStart']);
    expect(live.models.connections).toEqual([expect.objectContaining({ adapter: 'managed', server: 'loom', models: [expect.objectContaining({ id: 'fake-1' })] })]);
  });

  it('loads the copied model of a declared server in a scratch home written from the copy', async () => {
    const live = liveSettingsFor(await loadUserModels({ home: scratchHome(USER_SETTINGS), signal: new AbortController().signal }), ['loom/fake-1']);
    const scratch = await loadUserModels({ home: scratchHome({ models: live.models }), signal: new AbortController().signal });
    expect(scratch.resolved.models.get('loom/fake-1')).toMatchObject({ adapter: 'managed', server: 'loom', binary: LOOM.command, model: 'fake-1' });
  });
});
