import fs from 'node:fs';
import path from 'node:path';
import { readSettingsSnapshot } from '@momonga/config';
import type { LocalServerDetection, PlanCatalogEntry } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import type { TuiBackend } from '../src/tui/backend.ts';
import { runAddFlow } from '../src/tui/models/add.ts';
import { runModelsHub } from '../src/tui/models/hub.ts';
import { runBillingFlow, runFallbackFlow, runRoleFlow, runStartFlow, runTimeoutsFlow } from '../src/tui/models/order.ts';
import { HUB_ACTIONS } from '../src/tui/models/texts.ts';
import { createPlanFlows } from '../src/tui/plan-flows.ts';
import { runSettingsScreen, settingsFileLines } from '../src/tui/settings-screen.tsx';
import type { SlashContext } from '../src/tui/slash.ts';
import { CHATGPT, account, fakePlanBackend } from './fake-plan-gateway.tsx';
import { LLAMA_SERVER, OLLAMA_ADDRESS, S2, S3, S4, ollamaFound, threeModels } from './models-shell-harness.ts';
import { NO, YES, flowOf, untilAborted } from './tui-models-harness.ts';
import type { FlowHarness, Step } from './tui-models-harness.ts';

type Connection = Record<string, unknown> & { models: Record<string, unknown>[] };
type Written = { models: Record<string, unknown> & { connections: Connection[] }; autoMode?: Record<string, unknown> };

const writtenOf = (harness: FlowHarness): Written => harness.written() as Written;

const SEARCHING = 'searching for model servers';
const CHECKING = 'checking the servers';
const MEASURING = 'measuring this model (once per model and OS build)';
const SEARCH = 'Search this computer for model servers';
const TYPE_ADDRESS = 'Type the address of a model server';
const SERVICE = 'Use a service with an API key';
const PROGRAM = 'Run a program as a model server';
const OLLAMA_ROW = 'ollama  ·  http://127.0.0.1:11434  ·  2 models';
const APIS = ['Ollama API', 'OpenAI-compatible API', 'Anthropic API', 'OpenAI Responses API'];
const KEY_VALUE = 'sk-the-key-value-0123456789';

const twoOnOllama = (): LocalServerDetection[] => [ollamaFound(OLLAMA_ADDRESS, ['devstral-small-2:latest', 'qwen3.8:27b'])];

const LMSTUDIO_ONLY = { models: { connections: [S2.models.connections[1]] } };

describe('the /models flows, one per row of 4.9.1', () => {
  it('row 1: a model of a server the search finds is added after the confirm row, and Esc cancels the search', async (context) => {
    const steps: Step[] = [{ pick: SEARCH }, { pick: OLLAMA_ROW }, { pick: 'devstral-small-2' }, { type: 'many' }, { type: '32768' }];
    const declined = flowOf(context, undefined, [...steps, NO], { found: twoOnOllama });
    await runAddFlow(declined.context);
    expect(declined.phases).toEqual([SEARCHING]);
    expect(declined.detections.map((request) => request.typed)).toEqual([[]]);
    expect(declined.picks().map((pick) => pick.rows)[1]).toEqual([OLLAMA_ROW]);
    expect(declined.picks()[2]?.rows).toEqual(['devstral-small-2', 'qwen3.8:27b']);
    expect(declined.prompts()).toEqual([{ kind: 'text', title: 'Context window for devstral-small-2:', hidden: false, problems: ['Enter a whole number of at least 1.'] }]);
    expect(declined.picks().at(-1)?.title).toBe('Add devstral-small-2 to your settings?');
    expect(declined.bytes()).toBeUndefined();

    const accepted = flowOf(context, undefined, [...steps, YES], { found: twoOnOllama });
    await runAddFlow(accepted.context);
    expect(writtenOf(accepted).models.connections).toMatchObject([{ adapter: 'ollama', baseUrl: OLLAMA_ADDRESS, models: [{ id: 'devstral-small-2:latest', capabilities: { contextWindow: 32768 } }] }]);
    expect(accepted.infos).toEqual(['Added devstral-small-2. It is used from the next request.']);

    const ceiling = flowOf(context, undefined, [{ pick: SEARCH }, { pick: /^ollama/ }, { pick: 'small' }, { type: '9000' }], {
      found: () => [{ kind: 'ollama', provider: 'ollama', address: OLLAMA_ADDRESS, models: [{ id: 'small:latest', tools: 'unknown', ceiling: 8192 }] }],
    });
    await runAddFlow(ceiling.context);
    expect(ceiling.prompts()).toEqual([{ kind: 'text', title: 'Context window for small (at most 8192):', hidden: false, problems: ['Enter a whole number from 1 to 8192.'] }]);

    const nothing = flowOf(context, undefined, [{ pick: SEARCH }, { pick: 'Back' }]);
    await runAddFlow(nothing.context);
    expect(nothing.picks()[1]).toEqual({ kind: 'pick', title: 'No model server answered on this computer.', lines: [], rows: [TYPE_ADDRESS, 'Back'] });

    const cancelled = flowOf(context, undefined, [{ pick: SEARCH }], { found: (request) => untilAborted(request.signal), cancelPhase: SEARCHING });
    await runAddFlow(cancelled.context);
    expect(cancelled.detections[0]?.signal.aborted).toBe(true);
    expect(cancelled.picks()).toHaveLength(1);
    expect(cancelled.bytes()).toBeUndefined();
  });

  it('row 2: a server typed by its address is asked at once, and one that does not answer is added by its API and model name', async (context) => {
    const address = 'http://127.0.0.1:8080';
    const harness = flowOf(context, undefined, [{ pick: TYPE_ADDRESS }, { type: 'the server' }, { type: address }, { pick: 'OpenAI-compatible API' }, { type: 'my-model' }, { type: '4096' }, YES]);
    await runAddFlow(harness.context);
    expect(harness.prompts()[0]).toEqual({ kind: 'text', title: 'Address (for example http://127.0.0.1:11434):', hidden: false, problems: ['Not an address. Write it like http://127.0.0.1:11434.'] });
    expect(harness.detections.map((request) => ({ candidates: request.candidates, typed: request.typed }))).toEqual([{ candidates: [], typed: [address] }]);
    expect(harness.picks()[1]).toMatchObject({ title: `No model server answered at ${address}. Add it anyway?`, rows: APIS });
    expect(harness.prompts().slice(1).map((prompt) => prompt.title)).toEqual(['Model name as the server calls it:', 'Context window for my-model:']);
    expect(harness.picks().at(-1)?.title).toBe('Add my-model to your settings?');
    expect(writtenOf(harness).models.connections).toMatchObject([{ adapter: 'chat-completions', baseUrl: address, models: [{ id: 'my-model', capabilities: { contextWindow: 4096 } }] }]);

    const answering = flowOf(context, undefined, [{ pick: TYPE_ADDRESS }, { type: OLLAMA_ADDRESS }, { pick: 'qwen3.8:27b' }, { type: '8192' }, YES], { found: twoOnOllama });
    await runAddFlow(answering.context);
    expect(writtenOf(answering).models.connections).toMatchObject([{ adapter: 'ollama', models: [{ id: 'qwen3.8:27b' }] }]);
  });

  it('row 3: a service with a key is added with a reference to the key, never its value', async (context) => {
    const lead: Step[] = [{ pick: SERVICE }, { pick: 'OpenAI Responses API' }, { type: 'https://api.openai.com/v1' }];
    const tail: Step[] = [{ type: 'Open AI' }, { type: 'openai' }, { type: 'gpt-5.5' }, { type: '400000' }];
    const stored = flowOf(context, undefined, [...lead, { pick: 'Save the key in the system secret store' }, { type: KEY_VALUE }, ...tail, YES]);
    await runAddFlow(stored.context);
    expect(stored.picks()[1]?.rows).toEqual(APIS.slice(1));
    expect(stored.picks()[2]?.rows).toEqual(['Read the key from an environment variable', 'Save the key in the system secret store']);
    expect(stored.prompts().map((prompt) => [prompt.title, prompt.hidden, prompt.problems])).toEqual([
      ['Address:', false, []],
      ['Key:', true, []],
      ['Name of the service, used for prices (for example openai; Enter to skip):', false, ['Use lower-case letters, digits, . _ - and start with a lower-case letter.']],
      ['Model name as the server calls it:', false, []],
      ['Context window for gpt-5.5:', false, []],
    ]);
    expect([...stored.secrets]).toEqual([['openai-api-key', KEY_VALUE]]);
    expect(stored.bytes()).not.toContain(KEY_VALUE);
    expect(writtenOf(stored).models.connections).toMatchObject([{ adapter: 'open-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeySecret: 'openai-api-key', models: [{ id: 'gpt-5.5' }] }]);

    const declined = flowOf(context, undefined, [...lead, { pick: 'Save the key in the system secret store' }, { type: KEY_VALUE }, ...tail, NO]);
    await runAddFlow(declined.context);
    expect(declined.secrets.size).toBe(0);
    expect(declined.bytes()).toBeUndefined();

    const named = flowOf(context, undefined, [...lead, { pick: 'Read the key from an environment variable' }, { type: '1KEY' }, { type: 'OPENAI_API_KEY' }, { type: '' }, { type: 'gpt-5.5' }, { type: '400000' }, YES]);
    await runAddFlow(named.context);
    expect(named.prompts()[1]).toEqual({ kind: 'text', title: 'Name of the environment variable (for example OPENAI_API_KEY):', hidden: false, problems: ['A variable name uses letters, digits and _ and does not start with a digit.'] });
    expect(writtenOf(named).models.connections).toMatchObject([{ apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5.5' }] }]);
    expect(named.secrets.size).toBe(0);
  });

  it('row 4: a plan model is added by the gateway through its own route, and a sign-out writes no model setting', async (context) => {
    const usable: PlanCatalogEntry = { slug: 'gpt-5.5', displayName: 'GPT-5.5', usable: true, contextWindow: 400000, maxOutputTokens: 128000 };
    const harness = flowOf(context, S3, [{ pick: /^gpt-5\.5/ }, { pick: /chatgpt/ }]);
    const backend = fakePlanBackend({ models: [], accounts: [account()], catalogs: { chatgpt: { readAt: '2026-11-10T00:00:00.000Z', models: [usable] } } });
    const connected: string[] = [];
    const choose = harness.context.overlays.choose;
    const flows = createPlanFlows({
      backend: backend as TuiBackend,
      pick: async (request) => (await choose(request))?.index,
      choose,
      promptText: harness.context.overlays.promptText,
      captureKey: async () => undefined,
      waiting: () => undefined,
      closeWaiting: () => undefined,
      delivered: () => undefined,
      loading: () => undefined,
      info: harness.context.info,
      toast: harness.context.info,
      connected: async (model) => void connected.push(model),
      refreshConnection: async () => undefined,
      signedIn: async () => undefined,
      found: harness.context.found,
      model: () => undefined,
      wait: harness.context.wait,
    });
    const before = harness.bytes();
    await flows.catalogPicker(CHATGPT, 'chatgpt');
    expect(backend.planCalls.at(-1)).toEqual({ route: 'accounts/chatgpt/targets', body: { profile: 'chatgpt', slug: 'gpt-5.5' } });
    expect(connected).toEqual(['chatgpt/gpt-5.5']);
    await flows.logout();
    expect(backend.planCalls.map((call) => call.route)).toContain('sign-out');
    expect(harness.bytes()).toBe(before);
  });

  it('row 5: removing a model names what it is also the model for, and the list is read once after the write', async (context) => {
    const harness = flowOf(context, threeModels({ start: 'qwen3.8:27b' }), [{ pick: /^qwen3\.8:27b/ }, { pick: 'Remove' }, YES]);
    await runModelsHub(harness.context);
    expect(harness.picks()[2]?.title).toBe('Remove qwen3.8:27b? It is also the model for: new sessions. Sessions that used it keep their history.');
    expect(harness.infos).toEqual(['Removed qwen3.8:27b.']);
    expect(writtenOf(harness).models.connections[0]?.models.map((model) => model['id'])).toEqual(['gemma-3-4b:latest']);
    expect(writtenOf(harness).models['start']).toBeUndefined();
    expect(harness.listings).toHaveLength(2);
    expect(harness.picks().at(-1)?.rows.some((row) => row.includes('qwen3.8:27b'))).toBe(false);

    const plain = flowOf(context, threeModels(), [{ pick: /^qwen3\.8:27b/ }, { pick: 'Remove' }, NO]);
    const before = plain.bytes();
    await runModelsHub(plain.context);
    expect(plain.picks()[2]?.title).toBe('Remove qwen3.8:27b? Sessions that used it keep their history.');
    expect(plain.bytes()).toBe(before);
  });

  it('row 6: removing a server names its models, and a declared program can be forgotten with it', async (context) => {
    const one = flowOf(context, S2, [{ pick: `ollama  ·  ${OLLAMA_ADDRESS}` }, { pick: 'Remove server' }, YES]);
    await runModelsHub(one.context);
    expect(one.picks()[1]?.rows).toEqual(['Edit server', 'Name this server', 'Remove server']);
    expect(one.picks()[2]?.title).toBe('Remove ollama and its model? Sessions that used it keep their history.');
    expect(writtenOf(one).models.connections.map((connection) => connection['provider'])).toEqual(['lmstudio']);

    const two = flowOf(context, threeModels({ start: 'qwen3.8:27b' }), [{ pick: `ollama  ·  ${OLLAMA_ADDRESS}` }, { pick: 'Remove server' }, NO]);
    await runModelsHub(two.context);
    expect(two.picks()[2]?.title).toBe('Remove ollama and its 2 models? It is also the model for: new sessions. Sessions that used them keep their history.');

    const program = flowOf(context, S4, [{ pick: 'llama-server' }, { pick: 'Remove server' }, { pick: 'Also forget the server program' }, YES]);
    await runModelsHub(program.context);
    expect(program.picks()[2]?.rows).toEqual(['Remove the server', 'Also forget the server program']);
    expect(writtenOf(program).models?.['servers']).toBeUndefined();
  });

  it('row 7: the model a new session starts with is chosen from the configured models, or left to the first one', async (context) => {
    const cleared = flowOf(context, threeModels({ start: 'qwen3.8:27b' }), [{ pick: 'Use the first model in my settings' }, YES]);
    await runStartFlow(cleared.context);
    expect(cleared.picks()[0]?.rows).toEqual(['ollama/gemma-3-4b', 'qwen3.8:27b  ·  starts new sessions', 'lmstudio/gemma-3-4b', 'Use the first model in my settings']);
    expect(writtenOf(cleared).models['start']).toBeUndefined();

    const chosen = flowOf(context, threeModels(), [{ pick: 'lmstudio/gemma-3-4b' }, YES]);
    await runStartFlow(chosen.context);
    expect(writtenOf(chosen).models['start']).toBe('lmstudio/gemma-3-4b');

    const declined = flowOf(context, threeModels(), [{ pick: 'lmstudio/gemma-3-4b' }, NO]);
    const before = declined.bytes();
    await runStartFlow(declined.context);
    expect(declined.bytes()).toBe(before);
  });

  it('row 8: fallback models are added, moved and removed, each after its confirm row', async (context) => {
    const title = 'If the model cannot answer, MomongaCode tries these in order';
    const harness = flowOf(
      context,
      threeModels(),
      [{ pick: 'Add a model' }, { pick: 'qwen3.8:27b' }, YES, { pick: 'Add a model' }, { pick: 'lmstudio/gemma-3-4b' }, YES, { pick: '1  qwen3.8:27b' }, { pick: 'Move down' }, YES, { pick: '2  qwen3.8:27b' }, { pick: 'Remove' }, YES],
      { model: 'ollama/gemma-3-4b:latest' },
    );
    await runFallbackFlow(harness.context);
    const lists = harness.picks().filter((pick) => pick.title === title);
    expect(lists[0]).toMatchObject({ lines: ['No fallback models. If the model cannot answer, the request fails.', 'ollama/gemma-3-4b'], rows: ['Add a model'] });
    expect(lists[1]).toMatchObject({ lines: ['ollama/gemma-3-4b → qwen3.8:27b'], rows: ['1  qwen3.8:27b', 'Add a model'] });
    expect(lists[2]?.rows).toEqual(['1  qwen3.8:27b', '2  lmstudio/gemma-3-4b', 'Add a model']);
    expect(lists[3]?.rows).toEqual(['1  lmstudio/gemma-3-4b', '2  qwen3.8:27b', 'Add a model']);
    expect(harness.picks().find((pick) => pick.title === 'qwen3.8:27b')?.rows).toEqual(['Remove', 'Move up', 'Move down']);
    const confirms = harness.picks().filter((pick) => pick.rows.join() === 'No,Yes').map((pick) => pick.title);
    expect(confirms).toEqual(['Add qwen3.8:27b as fallback 1?', 'Add lmstudio/gemma-3-4b as fallback 2?', 'Move qwen3.8:27b to position 2?', 'Remove qwen3.8:27b from the fallback models?']);
    expect(writtenOf(harness).models['fallback']).toEqual(['lmstudio/gemma-3-4b']);
  });

  it('row 9: a billing change is asked inside the fallback flow and listed by /models billing', async (context) => {
    const { billingChanges: _allowed, fallback: _fallback, ...rest } = S3.models;
    const asked = flowOf(context, { models: rest }, [{ pick: 'Add a model' }, { pick: 'openai/gpt-5.5' }, YES, { pick: 'Only for openai/gpt-5.5' }, YES]);
    await runFallbackFlow(asked.context);
    expect(asked.picks()[2]?.title).toBe('Requests that fall from plan to metered would be charged by openai. Allow this change? [y/N]');
    expect(asked.picks()[3]).toMatchObject({ title: 'Allow it for every model, or only for openai/gpt-5.5?', rows: ['For every model', 'Only for openai/gpt-5.5'] });
    expect(asked.picks()[4]?.title).toBe('Add openai/gpt-5.5 as fallback 1?');
    expect(writtenOf(asked).models).toMatchObject({ fallback: ['openai/gpt-5.5'], billingChanges: [{ from: 'plan', to: 'metered', model: 'openai/gpt-5.5' }] });

    const listed = flowOf(context, S3, [{ pick: 'plan → metered  ·  every model' }, { pick: 'Forbid' }, YES]);
    await runBillingFlow(listed.context);
    expect(listed.picks()[0]?.rows).toEqual(['plan → metered  ·  every model']);
    expect(listed.picks()[1]?.rows).toEqual(['Forbid']);
    expect(writtenOf(listed).models['billingChanges']).toBeUndefined();
    expect(listed.infos.at(-1)).toBe('No billing change is allowed.');
  });

  it('row 10: the model of each other job is chosen from the configured models or left to the session', async (context) => {
    const session = "the session's model";
    const harness = flowOf(context, threeModels(), [
      { pick: /^Summaries/ },
      { pick: 'qwen3.8:27b' },
      YES,
      { pick: /^Auto-mode classifier/ },
      { pick: 'qwen3.8:27b' },
      YES,
      { pick: /^Summaries/ },
      { pick: "Use the session's model" },
      YES,
    ]);
    await runRoleFlow(harness.context);
    expect(harness.picks()[0]?.rows).toEqual([`Summaries (compaction)  ·  ${session}`, `Reflection  ·  ${session}`, `Analysis  ·  ${session}`, `Auto-mode classifier  ·  ${session}`]);
    expect(harness.picks()[1]?.rows).toEqual(['ollama/gemma-3-4b', 'qwen3.8:27b', 'lmstudio/gemma-3-4b', "Use the session's model"]);
    const confirms = harness.picks().filter((pick) => pick.rows.join() === 'No,Yes').map((pick) => pick.title);
    expect(confirms).toEqual(['Use qwen3.8:27b for summaries?', 'Use qwen3.8:27b for the auto-mode classifier?', "Use the session's model for summaries?"]);
    expect(writtenOf(harness).models['roles']).toBeUndefined();
    expect(writtenOf(harness).autoMode).toEqual({ classifier: 'ollama/qwen3.8:27b' });
  });

  it('row 11: a number of a model is edited from its row', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: /^qwen3\.8:27b/ }, { pick: 'Edit' }, { pick: /^Context window/ }, { type: '65536' }, YES]);
    await runModelsHub(harness.context);
    expect(harness.picks()[1]?.rows).toEqual(['Edit', 'Remove']);
    expect(harness.prompts()[0]?.title).toBe('Context window for qwen3.8:27b:');
    expect(harness.picks().find((pick) => pick.rows.join() === 'No,Yes')?.title).toBe('Set Context window of qwen3.8:27b to 65536?');
    expect(harness.infos).toEqual(['Set Context window of qwen3.8:27b to 65536.']);
    expect(writtenOf(harness).models.connections[0]?.models[1]).toMatchObject({ capabilities: { contextWindow: 65536 } });
  });

  it('row 12: a server is given a name, and a taken or reserved name is refused with its sentence', async (context) => {
    const harness = flowOf(context, threeModels({ start: 'lmstudio/gemma-3-4b' }), [{ pick: /^lmstudio/ }, { pick: 'Name this server' }, { type: 'ollama' }, { type: 'Studio' }, { type: 'studio' }, YES]);
    await runModelsHub(harness.context);
    expect(harness.prompts()[0]).toEqual({
      kind: 'text',
      title: 'Name (lower-case letters, digits, . _ - ; Enter to remove it):',
      hidden: false,
      problems: ['ollama is already used by another server.', 'Use lower-case letters, digits, . _ - and start with a lower-case letter.'],
    });
    expect(harness.picks().find((pick) => pick.rows.join() === 'No,Yes')?.title).toBe(
      'Rename server lmstudio to studio? This changes: new sessions. Conversations that used a model of this server will ask you to choose a model again.',
    );
    expect(writtenOf(harness).models).toMatchObject({ start: 'studio/gemma-3-4b', connections: [{}, { provider: 'studio' }] });

    const reserved = flowOf(context, LMSTUDIO_ONLY, [{ pick: /^lmstudio/ }, { pick: 'Name this server' }, { type: 'ollama' }]);
    const before = reserved.bytes();
    await runModelsHub(reserved.context);
    expect(reserved.infos).toEqual(['"ollama" is the name of Ollama servers, which use the Ollama API; this server uses the OpenAI-compatible API. Choose another name.']);
    expect(reserved.bytes()).toBe(before);
  });

  it('row 13: a program is declared and its model read by starting it once, after one confirm row', async (context) => {
    const steps: Step[] = [{ pick: PROGRAM }, { type: 'llama-server' }, { type: LLAMA_SERVER.command }, { type: '--socket {socket}' }, { type: 'health' }, { type: '/health' }, { type: '' }];
    const harness = flowOf(context, undefined, [...steps, YES], { programModel: 'qwen3-coder-30b' });
    await runAddFlow(harness.context);
    expect(harness.picks()[0]?.rows).toEqual([SEARCH, TYPE_ADDRESS, SERVICE, PROGRAM, 'Use the Apple on-device model']);
    expect(harness.prompts().map((prompt) => [prompt.title, prompt.problems])).toEqual([
      ['Write the full path of the program.', ['That is not a full path.']],
      ['Arguments (write {socket} where the program takes the path of its socket):', []],
      ['Path that answers when it is ready (for example /health):', ['Write a path starting with /.']],
      ['Name for this server (Enter: llama-server):', []],
    ]);
    expect(harness.phases).toContain(MEASURING);
    expect(harness.picks().at(-1)?.title).toBe(`Add llama-server (${LLAMA_SERVER.command}) as a model server with the model qwen3-coder-30b?`);
    expect(writtenOf(harness).models).toMatchObject({ servers: { 'llama-server': LLAMA_SERVER }, connections: [{ adapter: 'managed', server: 'llama-server', models: [{ id: 'qwen3-coder-30b' }] }] });

    const failing = flowOf(context, undefined, steps);
    await runAddFlow(failing.context);
    expect(failing.infos).toEqual(['the program was started, but this case gives no model for it']);
    expect(failing.bytes()).toBeUndefined();
  });

  it('row 14: the wait limits are shown as they are in force and set in minutes', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: /^Wait for the first reply/ }, { type: 'soon' }, { type: '0' }, YES, { pick: /^Wait without any data/ }, { type: '10' }, YES]);
    await runTimeoutsFlow(harness.context);
    const lists = harness.picks().filter((pick) => pick.title === 'Wait limits');
    expect(lists[0]?.rows).toEqual(['Wait for the first reply: 5 min', 'Wait without any data: 5 min']);
    expect(lists[1]?.rows).toEqual(['Wait for the first reply: never cut', 'Wait without any data: 5 min']);
    expect(lists[2]?.rows).toEqual(['Wait for the first reply: never cut', 'Wait without any data: 10 min']);
    expect(harness.prompts()[0]).toEqual({ kind: 'text', title: 'Minutes (0: never cut):', hidden: false, problems: ['Write a whole number of minutes, 0 or more.'] });
    expect(writtenOf(harness).models).toMatchObject({ headersTimeoutMs: 0, idleTimeoutMs: 600000 });
  });

  it('row 15: the schema dialects of the settings screen are written by the one writer, which refuses an invalid object', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: /^Schema dialects/ }, { type: '{"mine": 5}' }]);
    const project = path.join(harness.place.home, 'project');
    fs.mkdirSync(project);
    const before = harness.bytes();
    const slash = {
      ...harness.context,
      commands: [],
      backend: { ...harness.context.backend, settings: async () => readSettingsSnapshot({ home: harness.place.home, projectDir: project, trusted: true }) },
      background: (_label: string, work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal),
    } as unknown as SlashContext;
    await runSettingsScreen(slash, []);
    const prompts = harness.prompts();
    expect(prompts[0]?.title).toBe('Schema dialects');
    expect(prompts).toHaveLength(2);
    expect(harness.bytes()).toBe(before);
  });

  it('row 16: /models shows one block per server with its models, the start model and what needs a sign-in', async (context) => {
    const harness = flowOf(context, threeModels({ start: 'qwen3.8:27b' }), []);
    await runModelsHub(harness.context);
    expect(harness.picks()[0]).toEqual({
      kind: 'pick',
      title: 'Models',
      lines: [],
      rows: [
        `ollama  ·  ${OLLAMA_ADDRESS}`,
        '  ollama/gemma-3-4b  ·  32.8k tokens  ·  local',
        '  qwen3.8:27b  ·  32.8k tokens  ·  local  ·  starts new sessions',
        'lmstudio  ·  http://127.0.0.1:1234/v1',
        '  lmstudio/gemma-3-4b  ·  4.1k tokens  ·  local',
        'Change',
        ...HUB_ACTIONS,
      ],
    });
    expect(HUB_ACTIONS).toContain('Programs');
    expect(HUB_ACTIONS).toContain('Check the servers');

    const plan = flowOf(context, S3, [], { health: { 'chatgpt/gpt-5.5': { ok: false, breaker: 'closed', reason: 'sign_in_required' } } });
    await runModelsHub(plan.context);
    expect(plan.picks()[0]?.rows.slice(0, 4)).toEqual(['chatgpt', '  chatgpt/gpt-5.5  ·  plan  ·  starts new sessions  ·  sign in required', 'openai  ·  https://api.openai.com/v1', '  openai/gpt-5.5  ·  400.0k tokens  ·  metered']);

    const plain = flowOf(context, { models: { connections: [{ adapter: 'chat-completions', provider: 'gpu-box', baseUrl: 'http://192.168.1.20:8080/v1', models: [{ id: 'm', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }] } }, []);
    await runModelsHub(plain.context);
    expect(plain.picks()[0]?.rows.slice(0, 3)).toEqual([
      'gpu-box  ·  http://192.168.1.20:8080/v1',
      '  The address of gpu-box is plain http to another computer: what you send to it is not encrypted.',
      '  m  ·  8.2k tokens  ·  metered  ·  starts new sessions',
    ]);

    const empty = flowOf(context, undefined, []);
    await runModelsHub(empty.context);
    expect(empty.picks()[0]).toMatchObject({ lines: ['No model is connected. Use /login to connect one.'], rows: ['Change', ...HUB_ACTIONS] });
  });

  it('row 17: the settings file is named by its path', async (context) => {
    const harness = flowOf(context, threeModels(), []);
    const project = path.join(harness.place.home, 'project');
    fs.mkdirSync(project);
    const snapshot = await readSettingsSnapshot({ home: harness.place.home, projectDir: project, trusted: true });
    expect(settingsFileLines(snapshot)[0]).toBe(`Settings file: ${harness.place.settingsFile}`);
  });

  it('row 18: a field of a server is edited from its row', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: /^lmstudio/ }, { pick: 'Edit server' }, { pick: /^Billing/ }, { pick: 'metered' }, YES]);
    await runModelsHub(harness.context);
    expect(harness.picks()[3]?.rows).toEqual(['local', 'metered', 'plan', 'Remove the value']);
    expect(harness.picks().find((pick) => pick.rows.join() === 'No,Yes')?.title).toBe('Set Billing of lmstudio to metered?');
    expect(harness.infos).toEqual(['Set Billing of lmstudio to metered.']);
    expect(writtenOf(harness).models.connections[1]).toMatchObject({ billing: 'metered' });
  });

  it('row 19: a declared program is edited field by field, and is not forgotten while a server uses it', async (context) => {
    const harness = flowOf(context, S4, [{ pick: 'Programs' }, { pick: 'llama-server' }, { pick: /^Ready path/ }, { type: 'ready' }, { type: '/ready' }, YES, { pick: 'Forget this program' }]);
    await runModelsHub(harness.context);
    expect(harness.picks()[2]?.rows).toEqual([`Command  ${LLAMA_SERVER.command}`, 'Arguments  --socket {socket}', 'Ready path  /health', 'Forget this program']);
    expect(harness.prompts()[0]).toEqual({ kind: 'text', title: 'Path that answers when it is ready (for example /health):', hidden: false, problems: ['Write a path starting with /.'] });
    const confirms = harness.picks().filter((pick) => pick.rows.join() === 'No,Yes').map((pick) => pick.title);
    expect(confirms).toEqual(['Set readyPath of llama-server?']);
    expect(harness.infos).toEqual(['Set readyPath of llama-server.', 'llama-server is used by llama-server; remove that server first.']);
    expect(writtenOf(harness).models).toMatchObject({ servers: { 'llama-server': { ...LLAMA_SERVER, readyPath: '/ready' } } });
  });

  it('row 20: checking the servers marks a configured model its server no longer lists, and Esc cancels the check', async (context) => {
    const found = (): LocalServerDetection[] => [ollamaFound(OLLAMA_ADDRESS, ['gemma-3-4b:latest'])];
    const harness = flowOf(context, threeModels(), [{ pick: 'Check the servers' }], { found: (request) => (request.typed[0] === OLLAMA_ADDRESS ? found() : []) });
    await runModelsHub(harness.context);
    expect(harness.phases).toEqual([CHECKING]);
    expect(harness.picks()[1]?.rows).toContain('  qwen3.8:27b  ·  32.8k tokens  ·  local  ·  not listed by the server');
    expect(harness.picks()[1]?.rows).toContain('  ollama/gemma-3-4b  ·  32.8k tokens  ·  local  ·  starts new sessions');

    const cancelled = flowOf(context, threeModels(), [{ pick: 'Check the servers' }], { found: (request) => untilAborted(request.signal), cancelPhase: CHECKING });
    await runModelsHub(cancelled.context);
    expect(cancelled.picks()[1]?.rows.some((row) => row.includes('not listed by the server'))).toBe(false);
  });
});
