import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedModel, UserModels } from '@momonga/config';
import { probeRecordKeyOf } from '@momonga/config';
import { endpointRecordFileName } from '@momonga/gateway';
import { nodeFiles } from '../src/node-ports.ts';
import { copyEndpointProbeRecord } from '../src/eval/context-effects.ts';
import { liveSettingsFor } from '../src/eval/context-host.ts';
import { firstModelOf, userModelsOf } from './user-models.ts';

const capabilities = { contextWindow: 8192, maxOutputTokens: 1024 };

type Configuration = readonly [string, Record<string, unknown>, readonly string[]];

const ollamaOverTcp: Configuration = ['ollama over tcp', { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'qwen3', capabilities }] }, ['endpoint http://127.0.0.1:11434 qwen3:latest']];

const chatCompletions = (toolCalling: string): Record<string, unknown> => ({ adapter: 'chat-completions', provider: 'p', baseUrl: 'https://upstream.invalid/v1', models: [{ id: 'm', toolCalling, capabilities }] });

const configurations: readonly Configuration[] = [
  ['managed fm', { adapter: 'managed', server: 'fm', binary: '/usr/bin/fm', models: [{ id: 'system' }] }, ['managed fm /usr/bin/fm system']],
  ['chat-completions auto', chatCompletions('auto'), ['endpoint https://upstream.invalid/v1 m']],
  ['chat-completions native', chatCompletions('native'), []],
  ['chat-completions constrained', chatCompletions('constrained'), []],
  ['open-responses', { adapter: 'open-responses', provider: 'p', baseUrl: 'https://upstream.invalid/v1', models: [{ id: 'm', capabilities }] }, []],
  ['anthropic', { adapter: 'anthropic', baseUrl: 'https://upstream.invalid', apiKeyEnv: 'UPSTREAM_KEY', models: [{ id: 'm', capabilities }] }, []],
  ollamaOverTcp,
  ['ollama over a socket', { adapter: 'ollama', socketPath: '/s/ollama.sock', models: [{ id: 'qwen3', capabilities }] }, ['endpoint unix:/s/ollama.sock qwen3:latest']],
];

const modelsWith = (connection: Record<string, unknown>): UserModels => userModelsOf({ connections: [connection] });

const copiedRecordsOf = (models: UserModels): string[] => {
  const settings = liveSettingsFor(models, [firstModelOf(models).canon]);
  return [...settings.managedTargets.map((source) => `managed ${source.server} ${source.binary} ${source.upstream}`), ...settings.endpointProbes.map((probe) => `endpoint ${probe.endpoint} ${probe.model}`)];
};

const gatewayRecordsOf = (resolved: ResolvedModel): string[] => {
  if (resolved.adapter === 'managed') return [`managed ${resolved.server} ${resolved.binary} ${resolved.model}`];
  const key = probeRecordKeyOf(resolved.canon, resolved);
  if (key === undefined) return [];
  return [key.kind === 'model' ? `model ${key.model}` : `endpoint ${key.key.endpoint} ${key.key.model}`];
};

describe('the probe records a case home receives', () => {
  it.each(configurations)('%s: the gateway reads the expected record', (_label, connection, expected) => {
    expect(gatewayRecordsOf(firstModelOf(modelsWith(connection)))).toEqual(expected);
  });

  it.each(configurations)('%s: the host copies exactly the record the gateway reads', (_label, connection, expected) => {
    expect(copiedRecordsOf(modelsWith(connection))).toEqual(expected);
  });
});

const directories: string[] = [];

const temporary = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-ollama-probe-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('the probe record of an Ollama model in a case home', () => {
  it('lands in the case probe directory under the file name the gateway reads, byte for byte', async () => {
    const owner = temporary();
    const caseProbe = path.join(temporary(), 'probe');
    const fileName = endpointRecordFileName({ endpoint: 'http://127.0.0.1:11434', model: 'qwen3:latest' });
    const text = '{"identity":"sha256:digest","identityFields":["digest"],"report":{}}\n';
    fs.writeFileSync(path.join(owner, fileName), text);
    const models = modelsWith(ollamaOverTcp[1]);
    const settings = liveSettingsFor(models, [firstModelOf(models).canon]);
    for (const probe of settings.endpointProbes) {
      await copyEndpointProbeRecord(nodeFiles, owner, caseProbe, probe);
    }
    expect(fs.readFileSync(path.join(caseProbe, fileName), 'utf8')).toBe(text);
  });
});
