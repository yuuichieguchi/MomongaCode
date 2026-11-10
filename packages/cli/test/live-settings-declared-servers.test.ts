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
    targets: {
      workbench: { adapter: 'managed', server: 'loom', model: 'fake-1' },
      oven: { adapter: 'managed', server: 'kiln', model: 'fake-2' },
    },
    aliases: { default: ['workbench'], baking: ['oven'] },
  },
};

describe('the eval scratch home carries the declaration of each server a copied target names (design-managed-servers 19.12; R-S19-25)', () => {
  it('copies the loom declaration for the default alias, and not the kiln one no copied target names', () => {
    const live = liveSettingsFor(loadUserModels({ home: scratchHome(USER_SETTINGS) }), ['default']);
    expect((live.models as Record<string, unknown>)['servers']).toEqual({ loom: LOOM });
    expect(live.models.targets).toEqual({ workbench: { adapter: 'managed', server: 'loom', model: 'fake-1' } });
  });

  it('loads the copied declared target in a scratch home written from the copy', () => {
    const live = liveSettingsFor(loadUserModels({ home: scratchHome(USER_SETTINGS) }), ['default']);
    const scratch = loadUserModels({ home: scratchHome({ models: live.models }) });
    expect(scratch.resolved.targets['workbench']).toMatchObject({ adapter: 'managed', server: 'loom', binary: LOOM.command, model: 'fake-1' });
  });
});
