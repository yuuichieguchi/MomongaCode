import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedModelTarget, UserModels } from '@momonga/config';
import { probeRecordKeyOf } from '@momonga/config';
import { endpointKeyOf, endpointRecordFileName } from '@momonga/gateway';
import { nodeFiles } from '../src/node-ports.ts';
import { copyEndpointProbeRecord } from '../src/eval/context-effects.ts';
import { liveSettingsFor } from '../src/eval/context-host.ts';

const capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  source: 'config',
  maxConcurrency: 4,
} as const;

const remote = { billing: 'metered', capabilities, maxConcurrency: 4, admissionTimeoutMs: 30000 } as const;

const declaredCapabilities = { contextWindow: 8192, maxOutputTokens: 1024 };

type Configuration = readonly [string, ResolvedModelTarget, Record<string, unknown>, readonly string[]];

const ollamaOverTcp: Configuration = [
  'ollama over tcp',
  { ...remote, adapter: 'ollama', model: 'qwen3', baseUrl: 'http://127.0.0.1:11434' },
  { adapter: 'ollama', model: 'qwen3', baseUrl: 'http://127.0.0.1:11434', capabilities: declaredCapabilities },
  ['endpoint http://127.0.0.1:11434 qwen3'],
];

const configurations: readonly Configuration[] = [
  ['fm', { adapter: 'fm', model: 'system', toolCalling: 'native', billing: 'local', maxConcurrency: 1, admissionTimeoutMs: 1000 }, { adapter: 'fm' }, ['target t']],
  [
    'chat-completions auto',
    { ...remote, adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'auto' },
    { adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'auto', capabilities: declaredCapabilities },
    ['endpoint https://upstream.invalid/v1 m'],
  ],
  [
    'chat-completions native',
    { ...remote, adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'native' },
    { adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'native', capabilities: declaredCapabilities },
    [],
  ],
  [
    'chat-completions constrained',
    { ...remote, adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'constrained' },
    { adapter: 'chat-completions', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'constrained', capabilities: declaredCapabilities },
    [],
  ],
  [
    'open-responses',
    { ...remote, adapter: 'open-responses', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', toolCalling: 'native' },
    { adapter: 'open-responses', model: 'm', provider: 'p', baseUrl: 'https://upstream.invalid/v1', capabilities: declaredCapabilities },
    [],
  ],
  [
    'anthropic',
    { ...remote, adapter: 'anthropic', model: 'm', baseUrl: 'https://upstream.invalid', toolCalling: 'native' },
    { adapter: 'anthropic', model: 'm', baseUrl: 'https://upstream.invalid', capabilities: declaredCapabilities },
    [],
  ],
  ollamaOverTcp,
  [
    'ollama over a socket',
    { ...remote, adapter: 'ollama', model: 'qwen3', socketPath: '/s/ollama.sock' },
    { adapter: 'ollama', model: 'qwen3', socketPath: '/s/ollama.sock', capabilities: declaredCapabilities },
    ['endpoint unix:/s/ollama.sock qwen3'],
  ],
];

const modelsWith = (resolved: ResolvedModelTarget, declared: Record<string, unknown>): UserModels =>
  ({
    declared: { aliases: { default: ['t'] }, targets: { t: declared } },
    resolved: { aliases: { default: ['t'] }, targets: { t: resolved }, roles: {} },
  }) as unknown as UserModels;

const copiedRecordsOf = (models: UserModels): string[] => {
  const settings = liveSettingsFor(models, 'default');
  return [...settings.fmTargets.map((target) => `target ${target}`), ...settings.endpointProbes.map((probe) => `endpoint ${endpointKeyOf(probe.upstream)} ${probe.model}`)];
};

const gatewayRecordsOf = (resolved: ResolvedModelTarget): string[] => {
  const key = probeRecordKeyOf('t', resolved);
  if (key === undefined) return [];
  return [key.kind === 'target' ? `target ${key.target}` : `endpoint ${key.key.endpoint} ${key.key.model}`];
};

describe('the probe records a case home receives', () => {
  it.each(configurations)('%s: the gateway reads the expected record', (_label, resolved, _declared, expected) => {
    expect(gatewayRecordsOf(resolved)).toEqual(expected);
  });

  it.each(configurations)('%s: the host copies exactly the record the gateway reads', (_label, resolved, declared, expected) => {
    expect(copiedRecordsOf(modelsWith(resolved, declared))).toEqual(expected);
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

describe('the probe record of an ollama target in a case home', () => {
  it('lands in the case probe directory under the file name the gateway reads, byte for byte', async () => {
    const owner = temporary();
    const caseProbe = path.join(temporary(), 'probe');
    const fileName = endpointRecordFileName({ endpoint: 'http://127.0.0.1:11434', model: 'qwen3' });
    const text = '{"identity":"sha256:digest","identityFields":["digest"],"report":{}}\n';
    fs.writeFileSync(path.join(owner, fileName), text);
    const [, resolved, declared] = ollamaOverTcp;
    const settings = liveSettingsFor(modelsWith(resolved, declared), 'default');
    for (const probe of settings.endpointProbes) {
      await copyEndpointProbeRecord(nodeFiles, owner, caseProbe, { endpoint: endpointKeyOf(probe.upstream), model: probe.model });
    }
    expect(fs.readFileSync(path.join(caseProbe, fileName), 'utf8')).toBe(text);
  });
});
