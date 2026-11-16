import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { loadUserSettings } from '@momonga/config';
import type { ServerRegistry } from '@momonga/config';
import { FM_SERVER, MANAGED_SERVERS } from '@momonga/protocol';
import type { ManagedServerDescription } from '@momonga/protocol';
import { detectLocalServers } from '../src/index.ts';
import { makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';

const registeredServersOf = (registry: ServerRegistry): readonly ManagedServerDescription[] => {
  const value = (config as Record<string, unknown>)['registeredServers'];
  if (typeof value !== 'function') throw new Error('@momonga/config does not export registeredServers (design-chatgpt-plan O-R5-6 L9)');
  return (value as (registry: ServerRegistry) => readonly ManagedServerDescription[])(registry);
};

const DECLARED_ID = 'workbench';
const DECLARED_COMMAND = '/opt/workbench/bin/serve';

const declaredServers = async (): Promise<ManagedServerDescription[]> => {
  const home = makeHome();
  writeSettings(home, {
    models: modelsOf({ bench: { adapter: 'managed', server: DECLARED_ID, model: 'bench-1' } }, { servers: { [DECLARED_ID]: { command: DECLARED_COMMAND, args: ['{socket}'], readyPath: '/health' } } }),
  });
  const { settings } = await loadUserSettings({ env: process.env, home, signal: new AbortController().signal });
  const registry = settings.models.servers;
  return [...registeredServersOf(registry)];
};

type ExecAnswer = { exitCode: number; stdout: string; stderr: string };

const detectWith = (servers: readonly ManagedServerDescription[], present: ReadonlySet<string>, exec: () => Promise<ExecAnswer>) =>
  detectLocalServers({
    candidates: [],
    typed: [],
    signal: new AbortController().signal,
    fetch: async () => {
      throw new TypeError('no endpoint answers in this test');
    },
    servers,
    exec,
    exists: async (file) => present.has(file),
  });

const passing = async (): Promise<ExecAnswer> => ({ exitCode: 0, stdout: '', stderr: '' });
const failing = async (): Promise<ExecAnswer> => ({ exitCode: 1, stdout: '', stderr: 'refused' });

const builtInIds = new Set(MANAGED_SERVERS.map((server) => server.id));

describe('O-R5-6 (E): user models.servers in detection (R06-73, S7)', () => {
  it('lists a declared server whose command exists as a managed row of its id and command', async () => {
    const found = await detectWith(await declaredServers(), new Set([DECLARED_COMMAND]), passing);
    expect(found.filter((row) => 'shape' in row && row.id === DECLARED_ID)).toEqual([{ shape: 'managed', id: DECLARED_ID, label: `the server ${DECLARED_ID}`, provider: DECLARED_ID, binary: DECLARED_COMMAND }]);
  });

  it('lists nothing for a declared server whose command does not exist', async () => {
    const found = await detectWith(await declaredServers(), new Set(), passing);
    expect(found.filter((row) => 'shape' in row && row.id === DECLARED_ID)).toEqual([]);
  });

  it('leaves the built-in rows as they are without the declaration', async () => {
    const present = new Set([DECLARED_COMMAND, FM_SERVER.binary.defaultPath]);
    const withDeclared = await detectWith(await declaredServers(), present, failing);
    const shippedOnly = await detectWith(MANAGED_SERVERS, present, failing);
    expect(withDeclared.filter((row) => 'shape' in row && builtInIds.has(row.id))).toEqual(shippedOnly);
    expect(shippedOnly.length).toBeGreaterThan(0);
  });

  it('never refuses a declared server: it has no preconditions, so a failing exec leaves its row plain', async () => {
    const found = await detectWith(await declaredServers(), new Set([DECLARED_COMMAND]), failing);
    expect(found.find((row) => 'shape' in row && row.id === DECLARED_ID)).toEqual({ shape: 'managed', id: DECLARED_ID, label: `the server ${DECLARED_ID}`, provider: DECLARED_ID, binary: DECLARED_COMMAND });
  });
});
