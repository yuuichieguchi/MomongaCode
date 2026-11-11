import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanCatalogEntry } from '@momonga/protocol';
import { withTempDir } from '@momonga/testkit';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { modelsCatalog, runModelsForm } from '../src/commands/models.ts';
import type { FormInput, ModelsForm } from '../src/commands/models.ts';
import { LLAMA_SERVER, OLLAMA_ADDRESS, S4, THREE_DISPLAYS, bytesOf, documentOf, homeWith, ollamaFound, shellOf, threeModels } from './models-shell-harness.ts';
import type { ShellFakes } from './models-shell-harness.ts';

const RUN_AGAIN = 'Run again with --yes to write it.\n';
const NOT_CONFIGURED = `The model "nope" is not configured. Configured models: ${THREE_DISPLAYS}.\n`;
const DIALECTS_FILE = 'dialects.json';

type Written = Record<string, unknown> & { models: Record<string, unknown> & { connections: (Record<string, unknown> & { models: Record<string, unknown>[] })[] } };

type WritingCase = {
  form: ModelsForm;
  settings: unknown | undefined;
  fakes?: ShellFakes;
  missing: FormInput;
  missingPrints?: string;
  input: FormInput;
  confirm: string;
  summaries: readonly string[];
  written(document: Written): void;
  refused?: { input: FormInput; sentence: string };
};

const input = (args: readonly string[], options: FormInput['options'] = {}): FormInput => ({ args, options });

const SEARCH_FINDS_OLLAMA: ShellFakes = { found: () => [ollamaFound(OLLAMA_ADDRESS, ['devstral-small-2:latest', 'qwen3.8:27b'])] };

const TWO_FALLBACKS = { fallback: ['ollama/qwen3.8:27b', 'lmstudio/gemma-3-4b'] };

const UNUSED_PROGRAM = threeModels({ servers: { 'llama-server': LLAMA_SERVER } });

const WRITING: readonly WritingCase[] = [
  {
    form: 'add',
    settings: undefined,
    fakes: SEARCH_FINDS_OLLAMA,
    missing: input([]),
    missingPrints: 'ollama  ·  http://127.0.0.1:11434  ·  2 models\n',
    input: input([], { model: 'devstral-small-2:latest', window: '131072' }),
    confirm: 'Add devstral-small-2 to your settings?',
    summaries: ['Added devstral-small-2. It is used from the next request.'],
    written: (document) =>
      expect(document).toEqual({
        models: { connections: [{ adapter: 'ollama', baseUrl: OLLAMA_ADDRESS, models: [{ id: 'devstral-small-2:latest', capabilities: { contextWindow: 131072, maxOutputTokens: 32768 } }] }] },
      }),
    refused: { input: input([], { model: 'nope', window: '4096' }), sentence: 'No model server on this computer lists "nope".\n' },
  },
  {
    form: 'remove',
    settings: threeModels(),
    missing: input([]),
    input: input(['qwen3.8:27b']),
    confirm: 'Remove qwen3.8:27b? Sessions that used it keep their history.',
    summaries: ['Removed qwen3.8:27b.'],
    written: (document) => expect(document.models.connections[0]?.models.map((entry) => entry['id'])).toEqual(['gemma-3-4b:latest']),
    refused: { input: input(['nope']), sentence: NOT_CONFIGURED },
  },
  {
    form: 'remove-server',
    settings: threeModels({ start: 'lmstudio/gemma-3-4b' }),
    missing: input([]),
    input: input(['lmstudio']),
    confirm: 'Remove lmstudio and its model? It is also the model for: new sessions. Sessions that used it keep their history.',
    summaries: ['Removed lmstudio and its 1 model.'],
    written: (document) => {
      expect(document.models.connections.map((connection) => connection['adapter'])).toEqual(['ollama']);
      expect(document.models).not.toHaveProperty('start');
    },
    refused: { input: input(['nope']), sentence: 'The server "nope" is not configured.\n' },
  },
  {
    form: 'start',
    settings: threeModels(),
    missing: input([]),
    input: input(['qwen3.8:27b']),
    confirm: 'Start new sessions with qwen3.8:27b?',
    summaries: ['New sessions start with qwen3.8:27b.'],
    written: (document) => expect(document.models['start']).toBe('ollama/qwen3.8:27b'),
    refused: { input: input(['nope']), sentence: NOT_CONFIGURED },
  },
  {
    form: 'fallback add',
    settings: threeModels(),
    missing: input([]),
    input: input(['qwen3.8:27b']),
    confirm: 'Add qwen3.8:27b as fallback 1?',
    summaries: ['Fallback order saved: qwen3.8:27b'],
    written: (document) => expect(document.models['fallback']).toEqual(['ollama/qwen3.8:27b']),
    refused: { input: input(['nope']), sentence: NOT_CONFIGURED },
  },
  {
    form: 'fallback remove',
    settings: threeModels(TWO_FALLBACKS),
    missing: input([]),
    input: input(['qwen3.8:27b']),
    confirm: 'Remove qwen3.8:27b from the fallback models?',
    summaries: ['Fallback order saved: lmstudio/gemma-3-4b'],
    written: (document) => expect(document.models['fallback']).toEqual(['lmstudio/gemma-3-4b']),
    refused: { input: input(['nope']), sentence: NOT_CONFIGURED },
  },
  {
    form: 'fallback move',
    settings: threeModels(TWO_FALLBACKS),
    missing: input(['lmstudio/gemma-3-4b']),
    input: input(['lmstudio/gemma-3-4b'], { to: '1' }),
    confirm: 'Move lmstudio/gemma-3-4b to position 1?',
    summaries: ['Fallback order saved: lmstudio/gemma-3-4b → qwen3.8:27b'],
    written: (document) => expect(document.models['fallback']).toEqual(['lmstudio/gemma-3-4b', 'ollama/qwen3.8:27b']),
    refused: { input: input(['nope'], { to: '1' }), sentence: NOT_CONFIGURED },
  },
  {
    form: 'billing allow',
    settings: threeModels(),
    missing: input(['local']),
    input: input(['local', 'metered'], { model: 'qwen3.8:27b' }),
    confirm: 'Allow requests to fall from local to metered for qwen3.8:27b?',
    summaries: ['Requests may now fall from local to metered for qwen3.8:27b.'],
    written: (document) => expect(document.models['billingChanges']).toEqual([{ from: 'local', to: 'metered', model: 'ollama/qwen3.8:27b' }]),
    refused: { input: input(['local', 'metered'], { model: 'nope' }), sentence: NOT_CONFIGURED },
  },
  {
    form: 'billing forbid',
    settings: threeModels({ billingChanges: [{ from: 'local', to: 'metered' }] }),
    missing: input([]),
    input: input(['local', 'metered']),
    confirm: 'Forbid requests to fall from local to metered?',
    summaries: ['Requests may no longer fall from local to metered.'],
    written: (document) => expect(document.models).not.toHaveProperty('billingChanges'),
    refused: { input: input(['local', 'metered'], { model: 'nope' }), sentence: NOT_CONFIGURED },
  },
  {
    form: 'role set',
    settings: threeModels(),
    missing: input(['compaction']),
    input: input(['compaction', 'qwen3.8:27b']),
    confirm: 'Use qwen3.8:27b for summaries?',
    summaries: ['Summaries now uses qwen3.8:27b.'],
    written: (document) => expect(document.models['roles']).toEqual({ compaction: 'ollama/qwen3.8:27b' }),
    refused: { input: input(['classifier', 'nope']), sentence: NOT_CONFIGURED },
  },
  {
    form: 'role clear',
    settings: threeModels({ roles: { compaction: 'ollama/qwen3.8:27b' } }),
    missing: input([]),
    input: input(['compaction']),
    confirm: "Use the session's model for summaries?",
    summaries: ["Summaries now uses the session's model."],
    written: (document) => expect(document.models).not.toHaveProperty('roles'),
  },
  {
    form: 'set',
    settings: threeModels(),
    missing: input(['qwen3.8:27b', 'capabilities.contextWindow']),
    input: input(['qwen3.8:27b', 'capabilities.contextWindow', '65536']),
    confirm: 'Set Context window of qwen3.8:27b to 65536?',
    summaries: ['Set Context window of qwen3.8:27b to 65536.'],
    written: (document) => expect(document.models.connections[0]?.models[1]?.['capabilities']).toEqual({ contextWindow: 65536, maxOutputTokens: 8192 }),
    refused: { input: input(['nope', 'capabilities.contextWindow', '65536']), sentence: NOT_CONFIGURED },
  },
  {
    form: 'unset',
    settings: threeModels({}, { maxConcurrency: 2 }),
    missing: input(['qwen3.8:27b']),
    input: input(['qwen3.8:27b', 'maxConcurrency']),
    confirm: 'Clear Concurrent requests of qwen3.8:27b?',
    summaries: ['Cleared Concurrent requests of qwen3.8:27b.'],
    written: (document) => expect(document.models.connections[0]?.models[1]).not.toHaveProperty('maxConcurrency'),
    refused: { input: input(['nope', 'maxConcurrency']), sentence: NOT_CONFIGURED },
  },
  {
    form: 'set-server',
    settings: threeModels(),
    missing: input(['lmstudio', 'maxConcurrency']),
    input: input(['lmstudio', 'maxConcurrency', '2']),
    confirm: 'Set Concurrent requests of lmstudio to 2?',
    summaries: ['Set Concurrent requests of lmstudio to 2.'],
    written: (document) => expect(document.models.connections[1]?.['maxConcurrency']).toBe(2),
    refused: { input: input(['nope', 'maxConcurrency', '2']), sentence: 'The server "nope" is not configured.\n' },
  },
  {
    form: 'unset-server',
    settings: threeModels(),
    missing: input(['lmstudio']),
    input: input(['lmstudio', 'maxConcurrency']),
    confirm: 'Clear Concurrent requests of lmstudio?',
    summaries: ['Cleared Concurrent requests of lmstudio.'],
    written: (document) => expect(document.models.connections[1]).not.toHaveProperty('maxConcurrency'),
    refused: { input: input(['nope', 'maxConcurrency']), sentence: 'The server "nope" is not configured.\n' },
  },
  {
    form: 'name',
    settings: threeModels({ start: 'lmstudio/gemma-3-4b' }),
    missing: input(['lmstudio']),
    input: input(['lmstudio', 'studio']),
    confirm: 'Rename server lmstudio to studio? This changes: new sessions. Conversations that used a model of this server will ask you to choose a model again.',
    summaries: ['Renamed lmstudio to studio.'],
    written: (document) => {
      expect(document.models.connections[1]?.['provider']).toBe('studio');
      expect(document.models['start']).toBe('studio/gemma-3-4b');
    },
    refused: { input: input(['lmstudio', 'ollama']), sentence: 'ollama is already used by another server.\n' },
  },
  {
    form: 'add-program',
    settings: undefined,
    missing: input([], { arg: [] }),
    input: input([], { command: LLAMA_SERVER.command, arg: LLAMA_SERVER.args, readyPath: LLAMA_SERVER.readyPath, model: 'qwen3-coder-30b' }),
    confirm: 'Add llama-server (/opt/llama/bin/llama-server) as a model server with the model qwen3-coder-30b?',
    summaries: ['Declared the server program llama-server.', 'Added qwen3-coder-30b. It is used from the next request.'],
    written: (document) => expect(document).toEqual({ models: { servers: { 'llama-server': LLAMA_SERVER }, connections: [{ adapter: 'managed', server: 'llama-server', models: [{ id: 'qwen3-coder-30b' }] }] } }),
    refused: { input: input([], { command: 'llama-server', arg: LLAMA_SERVER.args, readyPath: '/health', model: 'x' }), sentence: 'models.servers.llama-server.command must be an absolute path; got "llama-server"\n' },
  },
  {
    form: 'set-program',
    settings: S4,
    missing: input(['llama-server', 'readyPath']),
    input: input(['llama-server', 'readyPath', '/ready']),
    confirm: 'Set readyPath of llama-server?',
    summaries: ['Set readyPath of llama-server.'],
    written: (document) => expect(document.models['servers']).toEqual({ 'llama-server': { ...LLAMA_SERVER, readyPath: '/ready' } }),
    refused: { input: input(['nope', 'readyPath', '/ready']), sentence: 'The server program "nope" is not declared.\n' },
  },
  {
    form: 'forget-program',
    settings: UNUSED_PROGRAM,
    missing: input([]),
    input: input(['llama-server']),
    confirm: 'Forget llama-server? 0 servers use it.',
    summaries: ['Forgot the server program llama-server.'],
    written: (document) => expect(document.models).not.toHaveProperty('servers'),
    refused: { input: input(['nope']), sentence: 'The server program "nope" is not declared.\n' },
  },
  {
    form: 'timeouts',
    settings: threeModels(),
    missing: input([]),
    input: input([], { headers: '10' }),
    confirm: 'Set the waits to first reply 10 min, no data 5 min?',
    summaries: ['Waits saved: first reply 10 min, no data 5 min.'],
    written: (document) => expect(document.models['headersTimeoutMs']).toBe(600000),
  },
  {
    form: 'dialects set',
    settings: threeModels(),
    missing: input([]),
    input: input([], { file: DIALECTS_FILE }),
    confirm: `Save the schema dialects of ${DIALECTS_FILE}?`,
    summaries: ['Schema dialects saved.'],
    written: (document) => expect(document.models['dialects']).toEqual({}),
  },
];

const withDialectsFile = (context: Parameters<typeof withTempDir>[0], given: FormInput): FormInput => {
  if (given.options['file'] !== DIALECTS_FILE) return given;
  const file = path.join(withTempDir(context), DIALECTS_FILE);
  fs.writeFileSync(file, '{}');
  return { ...given, options: { ...given.options, file } };
};

describe.each(WRITING)('momonga models $form', (entry) => {
  it('prints its usage on stderr, exits 2 and writes nothing when a required argument is missing', async (context) => {
    const at = homeWith(context, entry.settings);
    const before = bytesOf(at.settingsFile);
    const harness = shellOf(at, entry.fakes);

    const code = await runModelsForm(harness.shell, entry.form, entry.missing);

    expect(code).toBe(2);
    expect(harness.err()).toMatch(new RegExp(`^usage: momonga models ${entry.form}\\b`));
    expect(harness.out()).toBe(entry.missingPrints ?? '');
    expect(bytesOf(at.settingsFile)).toBe(before);
  });

  it('prints the confirm sentence, asks for --yes on stderr, exits 2 and writes nothing without --yes', async (context) => {
    const at = homeWith(context, entry.settings);
    const before = bytesOf(at.settingsFile);
    const harness = shellOf(at, entry.fakes);
    const given = withDialectsFile(context, entry.input);

    const code = await runModelsForm(harness.shell, entry.form, given);

    expect(harness.out()).toBe(`${entry.confirm.replace(DIALECTS_FILE, String(given.options['file'] ?? DIALECTS_FILE))}\n`);
    expect(harness.err()).toBe(RUN_AGAIN);
    expect(code).toBe(2);
    expect(bytesOf(at.settingsFile)).toBe(before);
  });

  it('writes with --yes, prints one summary line per operation and exits 0', async (context) => {
    const at = homeWith(context, entry.settings);
    const harness = shellOf(at, entry.fakes);
    const given = withDialectsFile(context, entry.input);

    const code = await runModelsForm(harness.shell, entry.form, { ...given, options: { ...given.options, yes: true } });

    expect(harness.err()).toBe('');
    expect(harness.out().split('\n').slice(1)).toEqual([...entry.summaries, '']);
    expect(code).toBe(0);
    entry.written(documentOf(at.settingsFile) as Written);
  });

  it.skipIf(entry.refused === undefined)('prints the sentence of a refused operation on stderr, exits 1 and writes nothing', async (context) => {
    const at = homeWith(context, entry.settings);
    const before = bytesOf(at.settingsFile);
    const harness = shellOf(at, entry.fakes);
    const refused = entry.refused as NonNullable<WritingCase['refused']>;

    const code = await runModelsForm(harness.shell, entry.form, { ...refused.input, options: { ...refused.input.options, yes: true } });

    expect(harness.err()).toBe(refused.sentence);
    expect(code).toBe(1);
    expect(bytesOf(at.settingsFile)).toBe(before);
  });
});

describe('momonga models set and set-server take only the fields of the writer', () => {
  it('refuses a field that is not in the table with the fields of the table, exits 1 and writes nothing', async (context) => {
    const at = homeWith(context, threeModels());
    const before = bytesOf(at.settingsFile);
    for (const [form, args, subject] of [
      ['set', ['qwen3.8:27b', 'nope', '1'], 'model'],
      ['unset', ['qwen3.8:27b', '__proto__.polluted'], 'model'],
      ['set-server', ['lmstudio', 'provider', 'studio'], 'server'],
      ['unset-server', ['lmstudio', '__proto__'], 'server'],
    ] as const) {
      const harness = shellOf(at);
      const code = await runModelsForm(harness.shell, form, input(args, { yes: true }));
      expect(harness.err()).toContain(`"${args[1]}" is not a field of a ${subject} that can be set. The fields are: `);
      expect(code).toBe(1);
      expect(bytesOf(at.settingsFile)).toBe(before);
    }
  });

  it('set <model> id <new> renames the model and rewrites the references to it', async (context) => {
    const at = homeWith(context, threeModels({ start: 'ollama/qwen3.8:27b', fallback: ['ollama/qwen3.8:27b'] }));
    const harness = shellOf(at);
    const code = await runModelsForm(harness.shell, 'set', input(['qwen3.8:27b', 'id', 'qwen3.9:27b'], { yes: true }));
    expect(harness.err()).toBe('');
    expect(code).toBe(0);
    expect(harness.out().split('\n')).toEqual(['Rename qwen3.8:27b to qwen3.9:27b?', 'Renamed qwen3.8:27b to qwen3.9:27b.', '']);
    const document = documentOf(at.settingsFile) as Written;
    expect(document.models.connections[0]?.models[1]?.['id']).toBe('qwen3.9:27b');
    expect(document.models['start']).toBe('ollama/qwen3.9:27b');
    expect(document.models['fallback']).toEqual(['ollama/qwen3.9:27b']);
  });
});

const CATALOG: readonly PlanCatalogEntry[] = [
  { slug: 'gpt-5.5', displayName: 'GPT-5.5', usable: true, contextWindow: 400000, maxOutputTokens: 128000 },
  { slug: 'gpt-old', displayName: 'GPT Old', usable: false, reason: 'the list reports no context window' },
];

const planOf = (): PlanGatewayClient =>
  ({
    accounts: async () => ({ profiles: [], accounts: [{ profile: 'chatgpt', label: 'chatgpt', state: 'signed_in', active: true, pinnedBy: [] }] }),
    accountModels: async () => ({ readAt: '2026-11-10T00:00:00.000Z', models: CATALOG }),
  }) as unknown as PlanGatewayClient;

type PrintingCase = { form: ModelsForm; settings: unknown; prints: string };

const PRINTING: readonly PrintingCase[] = [
  { form: 'fallback list', settings: threeModels(TWO_FALLBACKS), prints: '1  qwen3.8:27b\n2  lmstudio/gemma-3-4b\n' },
  { form: 'billing list', settings: threeModels({ billingChanges: [{ from: 'local', to: 'metered' }, { from: 'local', to: 'plan', model: 'ollama/qwen3.8:27b' }] }), prints: 'local → metered  ·  every model\nlocal → plan  ·  only qwen3.8:27b\n' },
  {
    form: 'role list',
    settings: threeModels({ roles: { compaction: 'ollama/qwen3.8:27b' } }),
    prints: "Summaries (compaction)  ·  qwen3.8:27b\nReflection  ·  the session's model\nAnalysis  ·  the session's model\nAuto-mode classifier  ·  the session's model\n",
  },
  { form: 'dialects show', settings: threeModels(), prints: '{}\n' },
];

describe('the forms of momonga models that only print', () => {
  it('momonga models catalog prints one line per model of the account in the format of the catalog row', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await modelsCatalog({ stdout: { write: (text) => void stdout.push(text) }, stderr: { write: (text) => void stderr.push(text) }, plan: planOf() }, { json: false });

    expect(code).toBe(0);
    expect(stdout.join('')).toBe('gpt-5.5  GPT-5.5  context 400000  max output 128000\ngpt-old  GPT Old  unusable: the list reports no context window\n');
    expect(stderr.join('')).toBe('');
  });

});

describe.each(PRINTING)('momonga models $form', (entry) => {
  it('prints its rows on stdout, exits 0 and leaves the settings file as it was', async (context) => {
    const at = homeWith(context, entry.settings);
    const before = bytesOf(at.settingsFile);
    const harness = shellOf(at);

    const code = await runModelsForm(harness.shell, entry.form, input([]));

    expect(harness.out()).toBe(entry.prints);
    expect(harness.err()).toBe('');
    expect(code).toBe(0);
    expect(bytesOf(at.settingsFile)).toBe(before);
  });
});

describe('the empty lists of the forms that only print', () => {
  it('says that there are no fallback models and that no billing change is allowed', async (context) => {
    const fallback = shellOf(homeWith(context, threeModels()));
    const billing = shellOf(homeWith(context, threeModels()));

    await runModelsForm(fallback.shell, 'fallback list', input([]));
    await runModelsForm(billing.shell, 'billing list', input([]));

    expect(fallback.out()).toBe('No fallback models. If the model cannot answer, the request fails.\n');
    expect(billing.out()).toBe('No billing change is allowed.\n');
  });
});
