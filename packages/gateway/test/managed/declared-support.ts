import fs from 'node:fs';
import path from 'node:path';
import { loadUserSettings } from '@momonga/config';
import { FM_SERVER } from '@momonga/protocol';
import type { ManagedServerDescription } from '@momonga/protocol';
import { makeHome, writeSettings, modelsOf } from '../gateway-process-helpers.ts';

export type Declaration = { command: string; args: readonly string[]; readyPath: string };

export const declaredForm = (id: string, declaration: Declaration): ManagedServerDescription => ({
  id,
  label: `the server ${id}`,
  provider: id,
  wire: 'chat-completions',
  binary: { defaultPath: declaration.command },
  launch: { argv: declaration.args },
  endpoint: FM_SERVER.endpoint,
  ready: { method: 'GET', path: declaration.readyPath, status: 200, limitMs: 10_000 },
  preconditions: [],
  identity: ['binarySha256', 'hostOsBuild'],
  restart: { backoffMs: 1000, maxRestarts: 5, windowMs: 60_000 },
  models: { listPath: '/v1/models', idPath: ['data', '0', 'id'] },
  toolForms: ['native', 'envelope'],
  tokenCount: 'estimated',
  errors: [],
  declarable: ['contextWindow', 'maxOutputTokens'],
  recordedDefaults: { stopSequences: false, imageInput: false, tokenCounting: 'estimated', usageReported: false, maxConcurrency: 1 },
  sampling: 'none',
});

export const registryOf = (models: unknown): ManagedServerDescription[] => {
  const servers = (models as { servers?: unknown }).servers;
  if (servers === undefined || servers === null) throw new Error('the resolved models carry no servers registry');
  return Object.values(servers as Record<string, ManagedServerDescription>);
};

export const loadedDeclaration = async (id: string, declaration: Declaration, home: string = makeHome()): Promise<ManagedServerDescription> => {
  writeSettings(home, { models: modelsOf({ workbench: { adapter: 'managed', server: id, model: 'fake-1' } }, { servers: { [id]: declaration } }) });
  const { settings } = await loadUserSettings({ home, signal: new AbortController().signal });
  const found = registryOf(settings.models).find((server) => server.id === id);
  if (found === undefined) throw new Error(`the loaded registry has no server ${JSON.stringify(id)}`);
  return found;
};

export const writeExecutable = (dir: string, name: string, text: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
};
