import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ENV_NAMES, editSettings, loadSettings, readSettingsSnapshot } from '@momonga/config';
import { createTempDir, removeTempDir, testKernelLock } from '@momonga/testkit';
import type { LocalServerDetection, PlanCatalogEntry } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import type { TuiBackend } from '../src/tui/backend.ts';
import { folderTrustFakes } from './fake-backend.ts';
import { runAddFlow } from '../src/tui/models/add.ts';
import { runModelsHub } from '../src/tui/models/hub.ts';
import { runBillingFlow, runClassifierFlow, runFallbackFlow, runRoleFlow, runStartFlow, runTimeoutsFlow } from '../src/tui/models/order.ts';
import { ADD_TITLE, HUB_ACTIONS } from '../src/tui/models/texts.ts';
import { createPlanFlows } from '../src/tui/plan-flows.ts';
import { SETTING_ROWS, currentOf, runSettingsScreen, settingLeaves, settingsFileLines, settingsRows, shownValue } from '../src/tui/settings-screen.tsx';
import type { SettingLeaf } from '../src/tui/settings-screen.tsx';
import type { SlashContext } from '../src/tui/slash.ts';
import { CHATGPT, account, fakePlanBackend } from './fake-plan-gateway.tsx';
import { LLAMA_SERVER, OLLAMA_ADDRESS, S1, S2, S3, S4, ollamaFound, threeModels } from './models-shell-harness.ts';
import { NO, YES, flowOf, untilAborted } from './tui-models-harness.ts';
import type { FlowHarness, Step } from './tui-models-harness.ts';

type Connection = Record<string, unknown> & { models: Record<string, unknown>[] };
type Written = { models: Record<string, unknown> & { connections: Connection[] }; autoMode?: Record<string, unknown> };

const writtenOf = (harness: FlowHarness): Written => harness.written() as Written;

const SEARCHING = 'searching for model servers';
const READING = 'reading this model';
const CHECKING = 'checking the servers';
const MEASURING = 'measuring this model (once per model and OS build)';
const SEARCH = 'Search this computer for model servers';
const TYPE_ADDRESS = 'Type the address of a model server';
const SERVICE = 'Use a service with an API key';
const PROGRAM = 'Run a program as a model server';
const LMSTUDIO_ADDRESS = 'http://127.0.0.1:1234/v1';
const OLLAMA_ROW = 'ollama  ·  http://127.0.0.1:11434  ·  2 models';
const APIS = ['Ollama API', 'OpenAI-compatible API', 'Anthropic API', 'OpenAI Responses API'];
const KEY_VALUE = 'sk-the-key-value-0123456789';

const twoOnOllama = (): LocalServerDetection[] => [ollamaFound(OLLAMA_ADDRESS, ['devstral-small-2:latest', 'qwen3.8:27b'])];

const LMSTUDIO_ONLY = { models: { connections: [S2.models.connections[1]] } };

describe('the flows of the Models screen, one per row of 4.9.1', () => {
  it('row 1: a found model that is already configured is not offered, and a server with nothing left to add says so (P-376)', async (context) => {
    const partly = flowOf(context, S1, [{ pick: SEARCH }, { pick: /^ollama/ }], { found: twoOnOllama });
    await runAddFlow(partly.context);
    expect(partly.picks()[1]?.rows).toEqual(['ollama  ·  http://127.0.0.1:11434  ·  1 model']);
    expect(partly.picks()[2]?.rows).toEqual(['ollama/qwen3.8:27b']);

    const whole = flowOf(context, S1, [{ pick: SEARCH }, { pick: /^ollama/ }], { found: () => [ollamaFound(OLLAMA_ADDRESS, ['devstral-small-2:latest'])] });
    await runAddFlow(whole.context);
    expect(whole.picks()).toHaveLength(2);
    expect(whole.infos).toEqual([`Every model that ollama at ${OLLAMA_ADDRESS} lists is in your settings already.`]);
  });

  it('row 1: a model of a server the search finds is added after the confirm row, and Esc cancels the search', async (context) => {
    const steps: Step[] = [{ pick: SEARCH }, { pick: OLLAMA_ROW }, { pick: 'ollama/devstral-small-2' }];
    const declined = flowOf(context, undefined, [...steps, NO], { found: twoOnOllama });
    await runAddFlow(declined.context);
    expect(declined.phases).toEqual([SEARCHING, READING]);
    expect(declined.detections.map((request) => request.typed)).toEqual([[]]);
    expect(declined.picks().map((pick) => pick.rows)[1]).toEqual([OLLAMA_ROW]);
    expect(declined.picks()[2]?.rows).toEqual(['ollama/devstral-small-2', 'ollama/qwen3.8:27b']);
    expect(declined.prompts()).toEqual([]);
    expect(declined.picks().at(-1)?.title).toBe('Add ollama/devstral-small-2 to your settings?');
    expect(declined.bytes()).toBeUndefined();

    const accepted = flowOf(context, undefined, [...steps, YES], { found: twoOnOllama });
    await runAddFlow(accepted.context);
    expect(writtenOf(accepted).models.connections).toMatchObject([{ adapter: 'ollama', baseUrl: OLLAMA_ADDRESS }]);
    expect(writtenOf(accepted).models.connections[0]?.models).toEqual([{ id: 'devstral-small-2:latest' }]);
    expect(accepted.infos).toEqual(['Added ollama/devstral-small-2. It is used from the next request.']);

    const ceiling = flowOf(context, undefined, [{ pick: SEARCH }, { pick: /^lmstudio/ }, { pick: 'lmstudio/small' }, { type: '9000' }], {
      found: () => [{ kind: 'lmstudio', provider: 'lmstudio', address: LMSTUDIO_ADDRESS, models: [{ id: 'small', tools: 'unknown', ceiling: 8192 }] }],
    });
    await runAddFlow(ceiling.context);
    expect(ceiling.prompts()).toEqual([{ kind: 'text', title: 'Context window for lmstudio/small (at most 8192):', hidden: false, problems: ['Enter a whole number from 1 to 8192.'] }]);

    const described = flowOf(context, undefined, [{ pick: SEARCH }, { pick: /^lmstudio/ }, { pick: 'lmstudio/small' }, YES], {
      found: () => [{ kind: 'lmstudio', provider: 'lmstudio', address: LMSTUDIO_ADDRESS, models: [{ id: 'small', tools: 'unknown', ceiling: 8192 }] }],
      describe: async (_server, model) => ({ ...model, contextWindow: 4096 }),
    });
    await runAddFlow(described.context);
    expect(described.prompts()).toEqual([]);
    expect(writtenOf(described).models.connections).toMatchObject([{ models: [{ id: 'small', capabilities: { contextWindow: 4096 } }] }]);

    const maximum = flowOf(context, undefined, [{ pick: SEARCH }, { pick: /^ollama/ }, { pick: 'ollama/small' }, YES], {
      found: () => [{ kind: 'ollama', provider: 'ollama', address: OLLAMA_ADDRESS, models: [{ id: 'small:latest', tools: 'unknown', ceiling: 8192 }] }],
      describe: async (_server, model) => ({ ...model, contextWindow: 4096 }),
    });
    await runAddFlow(maximum.context);
    expect(maximum.prompts()).toEqual([]);
    expect(writtenOf(maximum).models.connections[0]?.models).toEqual([{ id: 'small:latest' }]);

    const nothing = flowOf(context, undefined, [{ pick: SEARCH }, { pick: 'Back' }]);
    await runAddFlow(nothing.context);
    expect(nothing.picks()[1]).toEqual({ kind: 'pick', title: 'No model server answered on this computer.', lines: [], rows: [TYPE_ADDRESS, 'Back'] });

    const cancelled = flowOf(context, undefined, [{ pick: SEARCH }], { found: (request) => untilAborted(request.signal), cancelPhase: SEARCHING });
    await runAddFlow(cancelled.context);
    expect(cancelled.detections[0]?.signal.aborted).toBe(true);
    expect(cancelled.picks().map((pick) => pick.title)).toEqual([ADD_TITLE, ADD_TITLE]);
    expect(cancelled.bytes()).toBeUndefined();
  });

  it('row 2: a server typed by its address is asked at once, and one that does not answer is added by its API and model name', async (context) => {
    const address = 'http://127.0.0.1:8080';
    const harness = flowOf(context, undefined, [{ pick: TYPE_ADDRESS }, { type: 'the server' }, { type: address }, { pick: 'OpenAI-compatible API' }, { type: 'my-model' }, { type: '4096' }, YES]);
    await runAddFlow(harness.context);
    expect(harness.prompts()[0]).toEqual({ kind: 'text', title: 'Address (for example http://127.0.0.1:11434):', hidden: false, problems: ['Not an address. Write it like http://127.0.0.1:11434.'] });
    expect(harness.detections.map((request) => ({ candidates: request.candidates, typed: request.typed }))).toEqual([{ candidates: [], typed: [address] }]);
    expect(harness.picks()[1]).toMatchObject({ title: `No model server answered at ${address}. Add it anyway?`, rows: APIS });
    expect(harness.prompts().slice(1).map((prompt) => prompt.title)).toEqual(['Model name as the server calls it:', 'Context window for srv-127.0.0.1-8080/my-model:']);
    expect(harness.picks().at(-1)?.title).toBe('Add srv-127.0.0.1-8080/my-model to your settings?');
    expect(writtenOf(harness).models.connections).toMatchObject([{ adapter: 'chat-completions', baseUrl: address, models: [{ id: 'my-model', capabilities: { contextWindow: 4096 } }] }]);

    const answering = flowOf(context, undefined, [{ pick: TYPE_ADDRESS }, { type: OLLAMA_ADDRESS }, { pick: 'ollama/qwen3.8:27b' }, YES], { found: twoOnOllama });
    await runAddFlow(answering.context);
    expect(answering.prompts().map((prompt) => prompt.title)).toEqual(['Address (for example http://127.0.0.1:11434):']);
    expect(writtenOf(answering).models.connections[0]?.models).toEqual([{ id: 'qwen3.8:27b' }]);

    const unansweredOllama = flowOf(context, undefined, [{ pick: TYPE_ADDRESS }, { type: address }, { pick: 'Ollama API' }, { type: 'my-model' }, YES]);
    await runAddFlow(unansweredOllama.context);
    expect(unansweredOllama.prompts().map((prompt) => prompt.title)).toEqual(['Address (for example http://127.0.0.1:11434):', 'Model name as the server calls it:']);
    expect(writtenOf(unansweredOllama).models.connections).toMatchObject([{ adapter: 'ollama', baseUrl: address }]);
    expect(writtenOf(unansweredOllama).models.connections[0]?.models).toEqual([{ id: 'my-model:latest' }]);
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
      read: async (read) => ({ kind: 'read', value: await read() }),
      closeScreen: () => undefined,
      delivered: () => undefined,
      loading: async (_title, read) => ({ kind: 'read', value: await read() }),
    invitationAnswered: () => undefined,
    untilNextKey: () => new AbortController().signal,
      info: harness.context.info,
      failed: harness.context.info,
      toast: harness.context.info,
      connected: async (model) => void connected.push(model),
      warn: harness.context.info,
      switchedThen: async (model, _effort, then) => {
        connected.push(model);
        await then();
      },
      effort: () => undefined,
      setEffort: async () => undefined,
      shownModel: (model) => model,
      timers: { setTimeout: (run) => setTimeout(run, 0), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
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
    const harness = flowOf(context, threeModels({ start: 'qwen3.8:27b' }), [{ pick: /^ollama\/qwen3\.8:27b/ }, { pick: 'Remove' }, YES]);
    await runModelsHub(harness.context);
    expect(harness.picks()[2]?.title).toBe('Remove ollama/qwen3.8:27b? It is also the model for: new sessions. Sessions that used it keep their history.');
    expect(harness.infos).toEqual(['Removed ollama/qwen3.8:27b.']);
    expect(writtenOf(harness).models.connections[0]?.models.map((model) => model['id'])).toEqual(['gemma-3-4b:latest']);
    expect(writtenOf(harness).models['start']).toBeUndefined();
    expect(harness.listings).toHaveLength(2);
    expect(harness.picks().at(-1)?.rows.some((row) => row.includes('ollama/qwen3.8:27b'))).toBe(false);

    const plain = flowOf(context, threeModels(), [{ pick: /^ollama\/qwen3\.8:27b/ }, { pick: 'Remove' }, NO]);
    const before = plain.bytes();
    await runModelsHub(plain.context);
    expect(plain.picks()[2]?.title).toBe('Remove ollama/qwen3.8:27b? Sessions that used it keep their history.');
    expect(plain.bytes()).toBe(before);
  });

  it('row 6: removing a server names its models, and a declared program can be forgotten with it', async (context) => {
    const one = flowOf(context, S2, [{ pick: `ollama  ·  ${OLLAMA_ADDRESS}  ·  not_running` }, { pick: 'Remove server' }, YES]);
    await runModelsHub(one.context);
    expect(one.picks()[1]?.rows).toEqual(['Edit server', 'Name this server', 'Remove server']);
    expect(one.picks()[2]?.title).toBe('Remove ollama and its model? Sessions that used it keep their history.');
    expect(writtenOf(one).models.connections.map((connection) => connection['provider'])).toEqual(['lmstudio']);

    const two = flowOf(context, threeModels({ start: 'qwen3.8:27b' }), [{ pick: `ollama  ·  ${OLLAMA_ADDRESS}  ·  not_running` }, { pick: 'Remove server' }, NO]);
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
    expect(cleared.picks()[0]?.rows).toEqual(['ollama/gemma-3-4b', 'ollama/qwen3.8:27b  ·  starts new sessions', 'lmstudio/gemma-3-4b', 'Use the first model in my settings']);
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
      [{ pick: 'Add a model' }, { pick: 'ollama/qwen3.8:27b' }, YES, { pick: 'Add a model' }, { pick: 'lmstudio/gemma-3-4b' }, YES, { pick: '1  ollama/qwen3.8:27b' }, { pick: 'Move down' }, YES, { pick: '2  ollama/qwen3.8:27b' }, { pick: 'Remove' }, YES],
      { model: 'ollama/gemma-3-4b:latest' },
    );
    await runFallbackFlow(harness.context);
    const lists = harness.picks().filter((pick) => pick.title === title);
    expect(lists[0]).toMatchObject({ lines: ['No fallback models. If the model cannot answer, the request fails.', 'ollama/gemma-3-4b'], rows: ['Add a model'] });
    expect(lists[1]).toMatchObject({ lines: ['ollama/gemma-3-4b → ollama/qwen3.8:27b'], rows: ['1  ollama/qwen3.8:27b', 'Add a model'] });
    expect(lists[2]?.rows).toEqual(['1  ollama/qwen3.8:27b', '2  lmstudio/gemma-3-4b', 'Add a model']);
    expect(lists[3]?.rows).toEqual(['1  lmstudio/gemma-3-4b', '2  ollama/qwen3.8:27b', 'Add a model']);
    expect(harness.picks().find((pick) => pick.title === 'ollama/qwen3.8:27b')?.rows).toEqual(['Remove', 'Move up', 'Move down']);
    const confirms = harness.picks().filter((pick) => pick.rows.join() === 'No,Yes').map((pick) => pick.title);
    expect(confirms).toEqual(['Add ollama/qwen3.8:27b as fallback 1?', 'Add lmstudio/gemma-3-4b as fallback 2?', 'Move ollama/qwen3.8:27b to position 2?', 'Remove ollama/qwen3.8:27b from the fallback models?']);
    expect(writtenOf(harness).models['fallback']).toEqual(['lmstudio/gemma-3-4b']);
  });

  it('row 9: a billing change is asked inside the fallback flow and listed by the Billing changes row', async (context) => {
    const { billingChanges: _allowed, fallback: _fallback, ...rest } = S3.models;
    const asked = flowOf(context, { models: rest }, [{ pick: 'Add a model' }, { pick: 'openai/gpt-5.5' }, YES, { pick: 'Only for openai/gpt-5.5' }, YES]);
    await runFallbackFlow(asked.context);
    expect(asked.picks()[2]).toMatchObject({ title: 'Requests that fall from plan to metered would be charged by openai. Allow this change?', rows: ['No', 'Yes'] });
    for (const pick of asked.picks().filter((shown) => shown.rows.join() === 'No,Yes')) expect(pick.title).toMatch(/\?$/);
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
      { pick: 'ollama/qwen3.8:27b' },
      YES,
      { pick: /^Subagents/ },
      { pick: 'lmstudio/gemma-3-4b' },
      YES,
      { pick: /^Auto-mode classifier/ },
      { pick: 'ollama/qwen3.8:27b' },
      YES,
      { pick: /^Summaries/ },
      { pick: "Use the session's model" },
      YES,
    ]);
    await runRoleFlow(harness.context);
    expect(harness.picks()[0]?.rows).toEqual([`Summaries (compaction)  ·  ${session}`, `Reflection  ·  ${session}`, `Analysis  ·  ${session}`, `Subagents  ·  ${session}`, `Auto-mode classifier  ·  ${session}`, 'Memory auto review  ·  not set']);
    expect(harness.picks()[1]?.rows).toEqual(['ollama/gemma-3-4b', 'ollama/qwen3.8:27b', 'lmstudio/gemma-3-4b', "Use the session's model"]);
    const confirms = harness.picks().filter((pick) => pick.rows.join() === 'No,Yes').map((pick) => pick.title);
    expect(confirms).toEqual(['Use ollama/qwen3.8:27b for summaries?', 'Use lmstudio/gemma-3-4b for subagents?', 'Use ollama/qwen3.8:27b for the auto-mode classifier?', "Use the session's model for summaries?"]);
    expect(writtenOf(harness).models['roles']).toEqual({ subagent: 'lmstudio/gemma-3-4b' });
    expect(writtenOf(harness).autoMode).toEqual({ classifier: 'ollama/qwen3.8:27b' });
  });

  it('row 10: the model of memory auto review is shown after the classifier and chosen from the configured models only, starting on the current one', async (context) => {
    const harness = flowOf(context, { ...threeModels(), memory: { autoReviewModel: 'ollama/qwen3.8:27b' } }, [{ pick: /^Memory auto review/ }, { pick: 'lmstudio/gemma-3-4b' }], { model: 'ollama/gemma-3-4b:latest' });
    const initials: (number | undefined)[] = [];
    const { overlays } = harness.context;
    await runRoleFlow({ ...harness.context, overlays: { ...overlays, choose: (request) => (initials.push(request.initial), overlays.choose(request)) } });
    const session = "the session's model";
    expect(harness.picks()[0]?.rows).toEqual([`Summaries (compaction)  ·  ${session}`, `Reflection  ·  ${session}`, `Analysis  ·  ${session}`, `Subagents  ·  ${session}`, `Auto-mode classifier  ·  ${session}`, 'Memory auto review  ·  ollama/qwen3.8:27b']);
    expect(harness.picks()[1]).toEqual({ kind: 'pick', title: 'Model for memory auto review', lines: [], rows: ['ollama/gemma-3-4b', 'ollama/qwen3.8:27b', 'lmstudio/gemma-3-4b'] });
    expect(initials[1]).toBe(1);
    expect(harness.picks()[2]?.rows.at(-1)).toBe('Memory auto review  ·  lmstudio/gemma-3-4b');
    expect(harness.written()['memory']).toEqual({ autoReviewModel: 'lmstudio/gemma-3-4b' });
    expect(writtenOf(harness).autoMode).toBeUndefined();
    expect(writtenOf(harness).models['roles']).toBeUndefined();
    expect(harness.infos).toEqual(['The memory auto review model is now lmstudio/gemma-3-4b.']);
  });

  it('row 10: the selection of memory auto review starts on the current model when it is stored by its bare name', async (context) => {
    const harness = flowOf(context, { ...threeModels(), memory: { autoReviewModel: 'qwen3.8:27b' } }, [{ pick: /^Memory auto review/ }, { leave: true }]);
    const initials: (number | undefined)[] = [];
    const { overlays } = harness.context;
    await runRoleFlow({ ...harness.context, overlays: { ...overlays, choose: (request) => (initials.push(request.initial), overlays.choose(request)) } });
    expect(harness.picks()[1]?.title).toBe('Model for memory auto review');
    expect(initials[1]).toBe(1);
  });

  it('row 10: the row of memory auto review shows a stored model that is not configured as it is stored, and Escape on its selection writes nothing', async (context) => {
    const harness = flowOf(context, { ...threeModels(), memory: { autoReview: true, autoReviewModel: 'openai/gpt-9' } }, [{ pick: /^Memory auto review/ }, { leave: true }]);
    const before = harness.bytes();
    await runRoleFlow(harness.context);
    expect(harness.picks()[0]?.rows.at(-1)).toBe('Memory auto review  ·  openai/gpt-9');
    expect(harness.picks()[1]?.title).toBe('Model for memory auto review');
    expect(harness.bytes()).toBe(before);
  });

  it('row 11: a number of a model is edited from its row', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: /^ollama\/qwen3\.8:27b/ }, { pick: 'Edit' }, { pick: /^Context window/ }, { type: '65536' }, YES]);
    await runModelsHub(harness.context);
    expect(harness.picks()[1]?.rows).toEqual(['Edit', 'Remove']);
    expect(harness.prompts()[0]?.title).toBe('Context window for ollama/qwen3.8:27b:');
    expect(harness.picks().find((pick) => pick.rows.join() === 'No,Yes')?.title).toBe('Set Context window of ollama/qwen3.8:27b to 65536?');
    expect(harness.infos).toEqual(['Set Context window of ollama/qwen3.8:27b to 65536.']);
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
    expect(harness.picks().at(-1)?.title).toBe(`Add llama-server (${LLAMA_SERVER.command}) as a model server with the model llama-server/qwen3-coder-30b?`);
    expect(writtenOf(harness).models).toMatchObject({ servers: { 'llama-server': LLAMA_SERVER }, connections: [{ adapter: 'managed', server: 'llama-server', models: [{ id: 'qwen3-coder-30b' }] }] });

    const failing = flowOf(context, undefined, steps);
    await runAddFlow(failing.context);
    expect(failing.infos).toEqual(['the program was started, but this case gives no model for it']);
    expect(failing.bytes()).toBeUndefined();
  });

  it('row 14: the wait limits are shown as they are in force and set in whole minutes, 1 or more', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: /^Wait for the first reply/ }, { type: 'soon' }, { type: '0' }, { type: '2' }, YES, { pick: /^Wait without any data/ }, { type: '10' }, YES]);
    await runTimeoutsFlow(harness.context);
    const lists = harness.picks().filter((pick) => pick.title === 'Wait limits');
    expect(lists[0]?.rows).toEqual(['Wait for the first reply: 5 min', 'Wait without any data: 5 min']);
    expect(lists[1]?.rows).toEqual(['Wait for the first reply: 2 min', 'Wait without any data: 5 min']);
    expect(lists[2]?.rows).toEqual(['Wait for the first reply: 2 min', 'Wait without any data: 10 min']);
    expect(harness.prompts()[0]).toEqual({ kind: 'text', title: 'Minutes (a whole number, 1 or more):', hidden: false, problems: ['Write a whole number of minutes, 1 or more.', 'Write a whole number of minutes, 1 or more.'] });
    expect(writtenOf(harness).models).toMatchObject({ headersTimeoutMs: 120000, idleTimeoutMs: 600000 });
  });

  it('row 15: the schema dialects of the settings screen are written by the one writer, which refuses an invalid object', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: /^Schema dialects/ }, { type: '{"mine": 5}' }]);
    const project = path.join(harness.place.home, 'project');
    fs.mkdirSync(project);
    const before = harness.bytes();
    const slash = {
      ...harness.context,
      commands: [],
      backend: { ...harness.context.backend, ...folderTrustFakes({ settingsPlace: () => ({ home: harness.place.home, projectDir: project }), trust: undefined, trustItems: undefined, cwd: () => project, record: () => undefined }), settings: async () => readSettingsSnapshot({ env: process.env, home: harness.place.home, projectDir: project, trusted: true, signal: new AbortController().signal }) },
      background: (_label: string, work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal),
    } as unknown as SlashContext;
    await runSettingsScreen(slash, []);
    const prompts = harness.prompts();
    expect(prompts[0]?.title).toBe('Schema dialects');
    expect(prompts).toHaveLength(2);
    expect(harness.bytes()).toBe(before);
  });

  it('row 16: the Models screen shows its servers, then its models with the start model and what needs a sign-in, then what can be changed, under three headings', async (context) => {
    const harness = flowOf(context, threeModels({ start: 'qwen3.8:27b' }), [], { found: (request) => (request.typed[0] === OLLAMA_ADDRESS ? [ollamaFound(OLLAMA_ADDRESS, ['gemma-3-4b:latest'])] : []) });
    await runModelsHub(harness.context);
    expect(harness.picks()[0]).toEqual({
      kind: 'pick',
      title: 'Models',
      lines: [],
      rows: [
        'Servers',
        `ollama  ·  ${OLLAMA_ADDRESS}  ·  ready`,
        'lmstudio  ·  http://127.0.0.1:1234/v1  ·  not_running',
        'Models',
        'ollama/gemma-3-4b  ·  32.8k tokens  ·  local',
        'ollama/qwen3.8:27b  ·  32.8k tokens  ·  local  ·  starts new sessions',
        'lmstudio/gemma-3-4b  ·  4.1k tokens  ·  local',
        'Change',
        ...HUB_ACTIONS,
      ],
    });
    expect(HUB_ACTIONS).toContain('Programs');
    expect(HUB_ACTIONS).toContain('Check the servers');

    const plan = flowOf(context, S3, [], { health: { 'chatgpt/gpt-5.5': { ok: false, breaker: 'closed', reason: 'sign_in_required' } } });
    await runModelsHub(plan.context);
    expect(plan.picks()[0]?.rows.slice(0, 5)).toEqual(['Servers', 'chatgpt  ·  sign_in_required', 'Models', 'chatgpt/gpt-5.5  ·  plan  ·  available  ·  starts new sessions  ·  sign in required', 'openai/gpt-5.5  ·  400k tokens  ·  metered']);

    const plain = flowOf(context, { models: { connections: [{ adapter: 'chat-completions', provider: 'gpu-box', baseUrl: 'http://192.168.1.20:8080/v1', models: [{ id: 'm', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }] } }, []);
    await runModelsHub(plain.context);
    expect(plain.picks()[0]?.rows.slice(0, 5)).toEqual([
      'Servers',
      'gpu-box  ·  http://192.168.1.20:8080/v1  ·  not_running',
      'The address of gpu-box is plain http to another computer: what you send to it is not encrypted.',
      'Models',
      'gpu-box/m  ·  8.2k tokens  ·  metered  ·  starts new sessions',
    ]);

    const empty = flowOf(context, undefined, []);
    await runModelsHub(empty.context);
    expect(empty.picks()[0]).toMatchObject({ lines: ['No model is connected. Use /login to sign in or add an API key, or /model to use a local server.'], rows: ['Change', ...HUB_ACTIONS] });
  });

  it('row 17: the settings file is named by its path', async (context) => {
    const harness = flowOf(context, threeModels(), []);
    const project = path.join(harness.place.home, 'project');
    fs.mkdirSync(project);
    const snapshot = await readSettingsSnapshot({ env: process.env, home: harness.place.home, projectDir: project, trusted: true, signal: new AbortController().signal });
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
    expect(harness.picks()[2]?.rows).toEqual([`Command  ${LLAMA_SERVER.command}`, 'Arguments  --socket {socket}', 'Ready path  /health', 'Model file  not set', 'Forget this program']);
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
    expect(harness.phases).toEqual([CHECKING, CHECKING, CHECKING]);
    expect(harness.picks()[1]?.rows).toContain('ollama/qwen3.8:27b  ·  32.8k tokens  ·  local  ·  not listed by the server');
    expect(harness.picks()[1]?.rows).toContain('ollama/gemma-3-4b  ·  32.8k tokens  ·  local  ·  starts new sessions');

    let asked = 0;
    const cancelled = flowOf(context, threeModels(), [{ pick: 'Check the servers' }], {
      found: (request) => {
        asked += 1;
        return asked === 3 || asked === 4 ? untilAborted(request.signal) : [];
      },
      cancelPhase: CHECKING,
      cancelOccurrence: 2,
    });
    await runModelsHub(cancelled.context);
    expect(cancelled.picks()[1]?.rows.some((row) => row.includes('not listed by the server'))).toBe(false);
  });

  it('the Servers rows end with a state asked of the server itself: a managed program by its health answer, a plan connection by its health answer, an address by a probe, a row with no answer shows none', async (context) => {
    const managed = flowOf(context, S4, [], { health: { 'llama-server/qwen3-coder-30b': { ok: true, breaker: 'closed' } } });
    await runModelsHub(managed.context);
    expect(managed.picks()[0]?.rows.slice(0, 2)).toEqual(['Servers', 'llama-server  ·  ready']);

    const unhealthy = flowOf(context, S4, [], { health: { 'llama-server/qwen3-coder-30b': { ok: false, breaker: 'closed', reason: 'unhealthy' } } });
    await runModelsHub(unhealthy.context);
    expect(unhealthy.picks()[0]?.rows.slice(0, 2)).toEqual(['Servers', 'llama-server  ·  unhealthy']);

    const unanswered = flowOf(context, S4, []);
    await runModelsHub(unanswered.context);
    expect(unanswered.picks()[0]?.rows.slice(0, 2)).toEqual(['Servers', 'llama-server']);
    expect(unanswered.detections).toEqual([]);

    const listsNothing = flowOf(context, threeModels(), [], { found: (request) => (request.typed[0] === OLLAMA_ADDRESS ? [ollamaFound(OLLAMA_ADDRESS, [])] : []) });
    await runModelsHub(listsNothing.context);
    expect(listsNothing.picks()[0]?.rows.slice(0, 2)).toEqual(['Servers', `ollama  ·  ${OLLAMA_ADDRESS}  ·  ready`]);
    expect(listsNothing.detections[0]).toMatchObject({ typed: [OLLAMA_ADDRESS], includeWithoutModels: true });

    const plan = flowOf(context, S3, [], { health: { 'chatgpt/gpt-5.5': { ok: true, breaker: 'closed' } } });
    await runModelsHub(plan.context);
    expect(plan.picks()[0]?.rows.slice(0, 2)).toEqual(['Servers', 'chatgpt  ·  ready']);
  });

  it('the screen does not open when Esc cancels the wait that reads the servers, and Esc does not wait for a read that never answers', async (context) => {
    const cancelled = flowOf(context, threeModels(), [], { found: (request) => untilAborted(request.signal), cancelPhase: CHECKING, holdHealth: true });
    await runModelsHub(cancelled.context);
    expect(cancelled.picks()).toEqual([]);
  });
});

describe("the session's model row of the role lists (chooseRoleModel, shared by /auto-mode and Models for other roles)", () => {
  const SESSION_ROW = "Use the session's model";
  const CLASSIFIER_CONFIRM = "Use the session's model for the auto-mode classifier?";
  const CLASSIFIER_SUMMARY = "The auto-mode classifier is now the session's model.";
  const ROWS = ['ollama/gemma-3-4b', 'ollama/qwen3.8:27b', 'lmstudio/gemma-3-4b', SESSION_ROW];
  const withClassifier = () => ({ ...threeModels(), autoMode: { classifier: 'ollama/qwen3.8:27b' } });

  it('on /auto-mode, writes inherit as the classifier when no classifier is configured', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: SESSION_ROW }, YES]);
    await runClassifierFlow(harness.context);
    expect(harness.picks()[0]?.rows).toEqual(ROWS);
    expect(harness.picks().filter((pick) => pick.rows.join() === 'No,Yes').map((pick) => pick.title)).toEqual([CLASSIFIER_CONFIRM]);
    expect(writtenOf(harness).autoMode).toEqual({ classifier: 'inherit' });
    expect(harness.infos).toEqual([CLASSIFIER_SUMMARY]);
  });

  it('on /auto-mode, replaces a configured classifier with inherit', async (context) => {
    const harness = flowOf(context, withClassifier(), [{ pick: SESSION_ROW }, YES]);
    await runClassifierFlow(harness.context);
    expect(writtenOf(harness).autoMode).toEqual({ classifier: 'inherit' });
    expect(harness.infos).toEqual([CLASSIFIER_SUMMARY]);
  });

  it('on the Auto-mode classifier row of Models for other roles, writes inherit as the classifier', async (context) => {
    const harness = flowOf(context, withClassifier(), [{ pick: /^Auto-mode classifier/ }, { pick: SESSION_ROW }, YES]);
    await runRoleFlow(harness.context);
    expect(harness.picks()[1]?.rows).toEqual(ROWS);
    expect(harness.picks().filter((pick) => pick.rows.join() === 'No,Yes').map((pick) => pick.title)).toEqual([CLASSIFIER_CONFIRM]);
    expect(writtenOf(harness).autoMode).toEqual({ classifier: 'inherit' });
    expect(harness.infos).toEqual([CLASSIFIER_SUMMARY]);
  });

  it.for([
    ['Summaries', 'compaction', 'summaries', 'Summaries'],
    ['Reflection', 'reflection', 'reflection', 'Reflection'],
    ['Analysis', 'analysis', 'analysis', 'Analysis'],
    ['Subagents', 'subagent', 'subagents', 'Subagents'],
  ] as const)('on the %s row of Models for other roles, still clears the role', async ([row, job, words, summaryHead], context) => {
    const roles = { compaction: 'ollama/qwen3.8:27b', reflection: 'ollama/qwen3.8:27b', analysis: 'ollama/qwen3.8:27b', subagent: 'ollama/qwen3.8:27b' };
    const harness = flowOf(context, threeModels({ roles }), [{ pick: new RegExp(`^${row}`) }, { pick: SESSION_ROW }, YES]);
    await runRoleFlow(harness.context);
    expect(harness.picks().filter((pick) => pick.rows.join() === 'No,Yes').map((pick) => pick.title)).toEqual([`Use the session's model for ${words}?`]);
    const { [job]: _cleared, ...kept } = roles as Record<string, string>;
    expect(writtenOf(harness).models['roles']).toEqual(kept);
    expect(harness.infos).toEqual([`${summaryHead} now uses the session's model.`]);
  });
});

describe('the row Auto review of the settings screen, section Memory', () => {
  const TITLE = 'Model for memory auto review';
  const ROWS = ['ollama/gemma-3-4b', 'ollama/qwen3.8:27b', 'lmstudio/gemma-3-4b'];
  const SESSION = 'ollama/gemma-3-4b:latest';

  const settingsOf = (harness: FlowHarness): SlashContext => {
    const project = path.join(harness.place.home, 'project');
    fs.mkdirSync(project);
    const place = { home: harness.place.home, projectDir: project };
    return {
      ...harness.context,
      commands: [],
      backend: {
        ...harness.context.backend,
        ...folderTrustFakes({ settingsPlace: () => place, trust: undefined, trustItems: undefined, cwd: () => project, record: () => undefined }),
        settings: async () => readSettingsSnapshot({ env: process.env, home: harness.place.home, projectDir: project, trusted: true, signal: new AbortController().signal }),
        editSettings: (layer: Parameters<typeof editSettings>[1], operation: Parameters<typeof editSettings>[2], signal: AbortSignal) => editSettings(place, layer, operation, { env: process.env, trusted: true, lock: testKernelLock(), signal }),
      },
      background: (_label: string, work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal),
    } as unknown as SlashContext;
  };

  const titles = (harness: FlowHarness): (string | undefined)[] => harness.picks().map((pick) => pick.title);

  type Save = { labels: string[]; phases: string[]; kept: (string | undefined)[] };

  const savingOf = async (harness: FlowHarness, row: string): Promise<Save> => {
    const slash = settingsOf(harness) as unknown as Record<string, unknown> & { overlays: FlowHarness['context']['overlays'] };
    const labels: string[] = [];
    const kept: (string | undefined)[] = [];
    const { overlays } = slash;
    await runSettingsScreen(
      {
        ...slash,
        background: (label: string, work: (signal: AbortSignal) => Promise<unknown>) => (labels.push(label), work(new AbortController().signal)),
        overlays: { ...overlays, choose: (request: Parameters<typeof overlays.choose>[0]) => (request.title === 'Settings' && kept.push((request.rows.find((entry) => entry.label === row) as { kept?: string } | undefined)?.kept), overlays.choose(request)) },
      } as unknown as SlashContext,
      [],
    );
    return { labels, phases: [...harness.phases], kept };
  };

  it.for([
    ['only the switch is written', { memory: { autoReviewModel: 'ollama/qwen3.8:27b' } }],
    ['the model of the session is written too', {}],
  ] as const)('saves Auto review the way an ordinary toggle row saves when %s', async ([, memory], context) => {
    const ordinary = await savingOf(flowOf(context, threeModels(), [{ pick: 'Repository facts' }], { model: SESSION }), 'Repository facts');
    const auto = await savingOf(flowOf(context, { ...threeModels(), ...memory }, [{ pick: 'Auto review' }], { model: SESSION }), 'Auto review');
    expect(ordinary.labels.length).toBeGreaterThan(0);
    expect(auto.labels).toEqual(ordinary.labels);
    expect(auto.phases).toEqual(ordinary.phases);
    expect(ordinary.kept[1]).toBeDefined();
    expect(auto.kept[1]).toBeDefined();
  });

  it('lists the row Auto review under the heading Memory', async (context) => {
    const harness = flowOf(context, threeModels(), [], { model: SESSION });
    await runSettingsScreen(settingsOf(harness), []);
    const rows = harness.picks()[0]?.rows ?? [];
    expect(rows).toContain('Auto review');
    expect(rows.indexOf('Auto review')).toBeGreaterThan(rows.indexOf('Memory'));
  });

  it('turning it on with no model set writes the model of the session with the switch to the user settings, without a selection', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: 'Auto review' }], { model: SESSION });
    await runSettingsScreen(settingsOf(harness), []);
    expect(harness.written()['memory']).toEqual({ autoReview: true, autoReviewModel: SESSION });
    expect(titles(harness)).not.toContain(TITLE);
    expect(titles(harness)).not.toContain('Save to:');
  });

  it('turning it on with a model set keeps that model', async (context) => {
    const harness = flowOf(context, { ...threeModels(), memory: { autoReview: false, autoReviewModel: 'ollama/qwen3.8:27b' } }, [{ pick: 'Auto review' }], { model: SESSION });
    await runSettingsScreen(settingsOf(harness), []);
    expect(harness.written()['memory']).toEqual({ autoReview: true, autoReviewModel: 'ollama/qwen3.8:27b' });
    expect(titles(harness)).not.toContain(TITLE);
  });

  it('turning it off keeps the model', async (context) => {
    const harness = flowOf(context, { ...threeModels(), memory: { autoReview: true, autoReviewModel: 'ollama/qwen3.8:27b' } }, [{ pick: 'Auto review' }], { model: SESSION });
    await runSettingsScreen(settingsOf(harness), []);
    expect(harness.written()['memory']).toEqual({ autoReview: false, autoReviewModel: 'ollama/qwen3.8:27b' });
    expect(titles(harness)).not.toContain(TITLE);
  });

  it('turning it on with no model set while the session has no model opens the selection, and choosing a row writes the model and the switch', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: 'Auto review' }, { pick: 'lmstudio/gemma-3-4b' }]);
    await runSettingsScreen(settingsOf(harness), []);
    expect(harness.picks().find((pick) => pick.title === TITLE)?.rows).toEqual(ROWS);
    expect(harness.written()['memory']).toEqual({ autoReview: true, autoReviewModel: 'lmstudio/gemma-3-4b' });
  });

  it('Escape on that selection changes nothing', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: 'Auto review' }, { leave: true }]);
    const before = harness.bytes();
    await runSettingsScreen(settingsOf(harness), []);
    expect(titles(harness)).toContain(TITLE);
    expect(harness.bytes()).toBe(before);
  });

  const placeOf = (harness: FlowHarness) => ({ home: harness.place.home, projectDir: path.join(harness.place.home, 'project') });

  const shownOf = async (harness: FlowHarness, row: string, before?: (place: ReturnType<typeof placeOf>) => Promise<void>, seen: string[] = []): Promise<(string | undefined)[]> => {
    const slash = settingsOf(harness) as unknown as Record<string, unknown> & { overlays: FlowHarness['context']['overlays'] };
    if (before !== undefined) await before(placeOf(harness));
    const shown: (string | undefined)[] = [];
    const { overlays } = slash;
    await runSettingsScreen(
      {
        ...slash,
        overlays: { ...overlays, choose: (request: Parameters<typeof overlays.choose>[0]) => (seen.push(JSON.stringify(request)), request.title === 'Settings' && shown.push((request.rows.find((entry) => entry.label === row && entry.separator !== true) as { value?: string } | undefined)?.value), overlays.choose(request)) },
      } as unknown as SlashContext,
      [],
    );
    seen.push(...harness.infos);
    return shown;
  };

  const projectFile = (place: ReturnType<typeof placeOf>): string => path.join(place.projectDir, '.momonga', 'settings.json');

  const writeProject = (document: unknown) => async (place: ReturnType<typeof placeOf>): Promise<void> => {
    fs.mkdirSync(path.dirname(projectFile(place)), { recursive: true });
    fs.writeFileSync(projectFile(place), `${JSON.stringify(document, null, 2)}\n`);
  };

  const writeLocal = (document: { memory: { autoReview: boolean } }) => async (place: ReturnType<typeof placeOf>): Promise<void> => {
    await editSettings(place, 'local', { kind: 'addRule', effect: 'allow', rule: 'Read' }, { env: process.env, trusted: true, lock: testKernelLock(), signal: new AbortController().signal });
    const file = localFile(place);
    fs.writeFileSync(file, `${JSON.stringify({ ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object), ...document }, null, 2)}\n`);
  };

  const localFile = (place: ReturnType<typeof placeOf>): string => {
    const projects = path.join(place.home, '.momonga', 'projects');
    const [hashed] = fs.readdirSync(projects);
    return path.join(projects, hashed ?? '', 'settings.local.json');
  };

  type Seeded = { file: string; bytes: string };

  const seeding = (seed: (place: ReturnType<typeof placeOf>) => Promise<void>, fileOf: (place: ReturnType<typeof placeOf>) => string, seeded: Seeded) => async (place: ReturnType<typeof placeOf>): Promise<void> => {
    await seed(place);
    seeded.file = fileOf(place);
    seeded.bytes = fs.readFileSync(seeded.file, 'utf8');
  };

  it('shows the state in force, off from the default, when only the project settings turn it on', async (context) => {
    const harness = flowOf(context, threeModels(), [], { model: SESSION });
    const shown = await shownOf(harness, 'Auto review', writeProject({ memory: { autoReview: true } }));
    expect(shown[0]).toBe('off  default');
  });

  it('Enter turns on the state in force in the user settings when only the project settings turn it on, leaving the project file alone', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: 'Auto review' }], { model: SESSION });
    let projectBefore: string | undefined;
    let projectPath = '';
    const shown = await shownOf(harness, 'Auto review', async (place) => {
      await writeProject({ memory: { autoReview: true } })(place);
      projectPath = projectFile(place);
      projectBefore = fs.readFileSync(projectPath, 'utf8');
    });
    expect(harness.written()['memory']).toEqual({ autoReview: true, autoReviewModel: SESSION });
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(projectBefore);
    expect(titles(harness)).not.toContain('Save to:');
    expect(shown[1]).toBe('on  user');
  });

  it('shows on from the user settings over a project false, and Enter writes off to the user settings', async (context) => {
    const harness = flowOf(context, { ...threeModels(), memory: { autoReview: true, autoReviewModel: 'ollama/qwen3.8:27b' } }, [{ pick: 'Auto review' }], { model: SESSION });
    const shown = await shownOf(harness, 'Auto review', writeProject({ memory: { autoReview: false } }));
    expect(shown[0]).toBe('on  user');
    expect(harness.written()['memory']).toEqual({ autoReview: false, autoReviewModel: 'ollama/qwen3.8:27b' });
  });

  it('shows the state in force, off from the default, when only the local settings turn it on', async (context) => {
    const harness = flowOf(context, threeModels(), [], { model: SESSION });
    const shown = await shownOf(harness, 'Auto review', writeLocal({ memory: { autoReview: true } }));
    expect(shown[0]).toBe('off  default');
  });

  it('the row ripgrep program shows the value in force, the default, when only the project settings set it', async (context) => {
    const harness = flowOf(context, threeModels(), [], { model: SESSION });
    const shown = await shownOf(harness, 'ripgrep program', writeProject({ tools: { ripgrep: '/opt/fake/project-rg' } }));
    expect(shown[0]).toBe('bundled  default');
  });

  it('a path typed on the row ripgrep program goes to the user settings without Save to: when only the project settings set it', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: 'ripgrep program' }, { type: '/opt/fake/user-rg' }], { model: SESSION });
    let projectBefore: string | undefined;
    let projectPath = '';
    await shownOf(harness, 'ripgrep program', async (place) => {
      await writeProject({ tools: { ripgrep: '/opt/fake/project-rg' } })(place);
      projectPath = projectFile(place);
      projectBefore = fs.readFileSync(projectPath, 'utf8');
    });
    expect(titles(harness)).not.toContain('Save to:');
    expect(harness.written()['tools']).toEqual({ ripgrep: '/opt/fake/user-rg' });
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(projectBefore);
  });

  it('the row Mouse shows the default when only the project settings turn it off', async (context) => {
    const harness = flowOf(context, threeModels(), [], { model: SESSION });
    const shown = await shownOf(harness, 'Mouse', writeProject({ tui: { mouse: false } }));
    expect(shown[0]).toBe('on  default');
  });

  it('the row Repository facts, honoured in the project settings, still shows the project value', async (context) => {
    const harness = flowOf(context, threeModels(), [], { model: SESSION });
    const shown = await shownOf(harness, 'Repository facts', writeProject({ memory: { repositoryFacts: false } }));
    expect(shown[0]).toBe('off  project');
  });

  it('after a path typed on the row ripgrep program, no sentence says the project sets it, and the row shows the typed path from the user settings', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: 'ripgrep program' }, { type: '/opt/fake/user-rg' }], { model: SESSION });
    const seen: string[] = [];
    const shown = await shownOf(harness, 'ripgrep program', writeProject({ tools: { ripgrep: '/opt/fake/project-rg' } }), seen);
    expect(seen.join('\n').match(/[^"]*sets it in[^"]*/g) ?? []).toEqual([]);
    expect(shown.at(-1)).toBe('/opt/fake/user-rg  user');
  });

  it.for([
    ['Mouse', { mouse: false }, { mouse: false }],
    ['Copy on select', { copyOnSelect: false }, { copyOnSelect: false }],
  ] as const)('Enter on the row %s turns over the value in force into the user settings when only the project settings set it', async ([row, project, written], context) => {
    const harness = flowOf(context, threeModels(), [{ pick: row }], { model: SESSION });
    const seen: string[] = [];
    const seeded: Seeded = { file: '', bytes: '' };
    const shown = await shownOf(harness, row, seeding(writeProject({ tui: project }), projectFile, seeded), seen);
    expect(shown[0]).toBe('on  default');
    expect(titles(harness)).not.toContain('Save to:');
    expect(harness.written()['tui']).toEqual(written);
    expect(seen.join('\n').match(/[^"]*sets it in[^"]*/g) ?? []).toEqual([]);
    expect(fs.readFileSync(seeded.file, 'utf8')).toBe(seeded.bytes);
  });

  it('the row Screen mode at start shows the default and a chosen mode goes to the user settings when only the project settings set it', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: 'Screen mode at start' }, { pick: 'scrollback' }], { model: SESSION });
    const seen: string[] = [];
    const seeded: Seeded = { file: '', bytes: '' };
    const shown = await shownOf(harness, 'Screen mode at start', seeding(writeProject({ tui: { screen: 'scrollback' } }), projectFile, seeded), seen);
    expect(shown[0]).toBe('fullscreen  default');
    expect(titles(harness)).not.toContain('Save to:');
    expect(harness.written()['tui']).toEqual({ screen: 'scrollback' });
    expect(seen.join('\n').match(/[^"]*sets it in[^"]*/g) ?? []).toEqual([]);
    expect(fs.readFileSync(seeded.file, 'utf8')).toBe(seeded.bytes);
  });

  it.for([
    ['Sandbox', { sandbox: 'bubblewrap' }, [{ pick: 'none' }, { pick: 'Yes' }], (written: Record<string, unknown>) => written['sandbox'], 'none', 'none  user'],
    ['Automatic updates', { autoUpdates: false }, [], (written: Record<string, unknown>) => written['autoUpdates'], false, 'off  user'],
    ['Retention of every store (days)', { retention: { days: 30 } }, [{ type: '45' }], (written: Record<string, unknown>) => (written['retention'] as Record<string, unknown> | undefined)?.['days'], 45, '45  user'],
  ] as const)('a change on the user-only row %s while only the project settings set it goes to the user settings without Save to:', async ([row, project, steps, writtenOf, written, after], context) => {
    const harness = flowOf(context, threeModels(), [{ pick: row }, ...steps], { model: SESSION });
    const seen: string[] = [];
    const seeded: Seeded = { file: '', bytes: '' };
    const shown = await shownOf(harness, row, seeding(writeProject(project), projectFile, seeded), seen);
    expect(titles(harness)).not.toContain('Save to:');
    expect(writtenOf(harness.written())).toBe(written);
    expect(fs.readFileSync(seeded.file, 'utf8')).toBe(seeded.bytes);
    expect(seen.join('\n').match(/[^"]*sets it in[^"]*/g) ?? []).toEqual([]);
    expect(shown.at(-1)).toBe(after);
  });

  it('Enter on Auto review while only the local settings turn it on turns it on in the user settings and leaves the local file alone', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: 'Auto review' }], { model: SESSION });
    const seeded: Seeded = { file: '', bytes: '' };
    await shownOf(harness, 'Auto review', seeding(writeLocal({ memory: { autoReview: true } }), localFile, seeded));
    expect(harness.written()['memory']).toEqual({ autoReview: true, autoReviewModel: SESSION });
    expect(fs.readFileSync(seeded.file, 'utf8')).toBe(seeded.bytes);
  });
});

describe('every row of the settings screen shows the value the loader has in force when a trusted project file sets it', () => {
  const SKIPPED: Readonly<Record<string, string>> = {
    'models.dialects': 'no candidate',
    'issues.watch': 'no candidate',
    'telemetry.otlp.headers': "<home>/.momonga/settings.json: invalid settings at /telemetry/otlp: must have required property 'endpoint'",
  };
  const TEXTS = ['http://127.0.0.1:9', '/opt/fake/value', 'value'];
  const FIXTURES: Readonly<Record<string, readonly unknown[]>> = {
    env: [{ [PROJECT_ENV_NAMES[0] ?? '']: 'value' }],
    pricing: [[{ provider: 'ollama', model: 'value', effectiveFrom: '2026-01-01', currency: 'USD', inputPerMTok: 1, outputPerMTok: 2 }]],
    forges: [[{ id: 'hub', descriptor: 'github', hosts: ['github.com'], apiBaseUrl: 'https://api.github.com', credential: { env: 'GITHUB_TOKEN' } }]],
    mandates: [{ triage: { ask: ['Bash'], steps: 20 } }],
    projectChecks: [{ '/opt/fake/project': { commands: ['npm test'] } }],
    projectApprovals: [{ '/opt/fake/project': { hooks: [] } }],
    'operations.approval': [{ PullRequestMerge: 'always' }],
  };

  const valueAt = (document: unknown, keys: readonly string[]): unknown => keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), document);

  const nested = (keys: readonly string[], value: unknown): unknown => keys.toReversed().reduce<unknown>((inner, key) => ({ [key]: inner }), value);

  const numbersOf = (schema: Readonly<Record<string, unknown>>, standing: unknown): number[] => {
    const minimum = typeof schema['minimum'] === 'number' ? schema['minimum'] : undefined;
    const maximum = typeof schema['maximum'] === 'number' ? schema['maximum'] : undefined;
    const base = typeof standing === 'number' ? standing : 0;
    return [base + 1, base - 1, minimum, maximum, 1, 2, 1000].filter((value): value is number => value !== undefined && (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum) && (schema['type'] !== 'integer' || Number.isInteger(value)));
  };

  const candidatesOf = (leaf: SettingLeaf, standing: unknown): unknown[] => {
    const items = (leaf.schema['items'] ?? {}) as Record<string, unknown>;
    const all: Record<SettingLeaf['kind'], () => unknown[]> = {
      toggle: () => [standing !== true],
      choice: () => [...(leaf.schema['enum'] as unknown[])],
      number: () => numbersOf(leaf.schema, standing),
      text: () => TEXTS,
      list: () => TEXTS.map((text) => [text]),
      choices: () => ((items['enum'] ?? []) as unknown[]).map((member) => [member]),
      map: () => [{ VALUE: 'value' }, { 'X-Value': 'value' }, { 'x-value': 'value' }],
      structured: () => [],
    };
    return [...(FIXTURES[leaf.key] ?? all[leaf.kind]())].filter((candidate) => JSON.stringify(candidate) !== JSON.stringify(standing));
  };

  const signal = (): AbortSignal => new AbortController().signal;

  const refusalOf = async (leaf: SettingLeaf, value: unknown): Promise<string | undefined> => {
    const home = createTempDir();
    try {
      const place = { home, projectDir: home };
      await editSettings(place, 'user', { kind: 'set', path: leaf.path, value }, { env: process.env, trusted: true, lock: testKernelLock(), signal: signal() });
      return undefined;
    } catch (error) {
      return (error instanceof Error ? error.message : String(error)).replaceAll(home, '<home>');
    } finally {
      removeTempDir(home);
    }
  };

  type Checked = { key: string; label: string; expected: string; received: string };

  const rowOf = async (home: string, project: string, label: string): Promise<string | undefined> => {
    const snapshot = await readSettingsSnapshot({ env: process.env, home, projectDir: project, trusted: true, signal: signal() });
    return settingsRows(snapshot, [], undefined).rows.find((row) => row.label === label && row.separator !== true)?.value;
  };

  const checked = async (leaf: SettingLeaf, label: string): Promise<Checked | { skipped: string }> => {
    const root = createTempDir();
    try {
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      fs.mkdirSync(home);
      fs.mkdirSync(project);
      const before = await readSettingsSnapshot({ env: process.env, home, projectDir: project, trusted: true, signal: signal() });
      const untouched = await rowOf(home, project, label);
      let chosen: { value: unknown } | undefined;
      const inForce = valueAt((await loadSettings({ env: process.env, home, projectDir: project, cli: {}, trust: { isTrusted: () => true }, signal: signal() })).settings, leaf.path);
      let refusal = 'no candidate';
      for (const candidate of candidatesOf(leaf, valueAt(before.defaults, leaf.path)).filter((value) => JSON.stringify(value) !== JSON.stringify(inForce))) {
        const refused = await refusalOf(leaf, candidate);
        if (refused === undefined) {
          chosen = { value: candidate };
          break;
        }
        refusal = refused;
      }
      if (chosen === undefined) return { skipped: refusal };
      fs.mkdirSync(path.join(project, '.momonga'));
      fs.writeFileSync(path.join(project, '.momonga', 'settings.json'), `${JSON.stringify(nested(leaf.path, chosen.value), null, 2)}\n`);
      const loaded = await loadSettings({ env: process.env, home, projectDir: project, cli: {}, trust: { isTrusted: () => true }, signal: signal() });
      const honoured = JSON.stringify(valueAt(loaded.settings, leaf.path)) === JSON.stringify(chosen.value);
      const received = (await rowOf(home, project, label)) ?? '';
      const expected = honoured ? `${shownValue(chosen.value)}  project` : (untouched ?? 'no row');
      return { key: leaf.key, label, expected, received };
    } finally {
      removeTempDir(root);
    }
  };

  it.for([['auto', false], ['bypassPermissions', false], ['acceptEdits', true]] as const)('the start mode that /permissions shows is the one the loader has in force when the project file sets %s', async ([mode, honoured]) => {
    const root = createTempDir();
    try {
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(project, '.momonga'), { recursive: true });
      fs.writeFileSync(path.join(project, '.momonga', 'settings.json'), `${JSON.stringify({ permissions: { defaultMode: mode } }, null, 2)}\n`);
      const loaded = await loadSettings({ env: process.env, home, projectDir: project, cli: {}, trust: { isTrusted: () => true }, signal: signal() });
      const snapshot = await readSettingsSnapshot({ env: process.env, home, projectDir: project, trusted: true, signal: signal() });
      expect(loaded.settings.permissions.defaultMode === mode).toBe(honoured);
      expect(currentOf(snapshot, ['permissions', 'defaultMode'])).toEqual(honoured ? { value: mode, source: 'project' } : { value: loaded.settings.permissions.defaultMode, source: 'default' });
    } finally {
      removeTempDir(root);
    }
  });

  const ROWS = settingLeaves().flatMap((leaf) => (SETTING_ROWS[leaf.key] === undefined ? [] : [{ leaf, label: SETTING_ROWS[leaf.key]?.label ?? '' }]));

  it('lists every row of the settings screen', () => {
    expect(ROWS.length).toBeGreaterThan(50);
  });

  it.for(ROWS.map(({ leaf, label }) => [leaf.key, leaf, label] as const))('the row of %s shows what the loader has in force when only a trusted project file sets it', { timeout: 120_000 }, async ([key, leaf, label]) => {
    const result = await checked(leaf, label);
    if ('skipped' in result) expect({ key, refusal: result.skipped }).toEqual({ key, refusal: SKIPPED[key] });
    else {
      expect(SKIPPED[key]).toBeUndefined();
      expect(result.received).toBe(result.expected);
    }
  });

  it('the row Environment variables shows the value in force when the project file sets a name off the project allowlist', async () => {
    const root = createTempDir();
    try {
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(project, '.momonga'), { recursive: true });
      const untouched = await rowOf(home, project, 'Environment variables');
      fs.writeFileSync(path.join(project, '.momonga', 'settings.json'), `${JSON.stringify({ env: { VALUE: 'value' } }, null, 2)}\n`);
      const loaded = await loadSettings({ env: process.env, home, projectDir: project, cli: {}, trust: { isTrusted: () => true }, signal: signal() });
      expect(loaded.settings.env['VALUE']).toBeUndefined();
      expect(await rowOf(home, project, 'Environment variables')).toBe(untouched);
    } finally {
      removeTempDir(root);
    }
  });
});
