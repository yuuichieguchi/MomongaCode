import { describe, expect, it } from 'vitest';
import { MODEL_SETTINGS_ROW, messageOf } from '@momonga/protocol';
import { MODELS_TITLE, START_ONE_TEXT } from '../src/tui/models/texts.ts';
import type { MomongaModelList } from '@momonga/protocol';
import type { TestContext } from 'vitest';
import { offeredServers } from '../src/commands/models.ts';
import type { TuiBackend } from '../src/tui/backend.ts';
import { folderTrustFakes } from './fake-backend.ts';
import { modelListRows } from '../src/tui/models/model-list.ts';
import { createPlanFlows } from '../src/tui/plan-flows.ts';
import { switchModel } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import { OLLAMA_ADDRESS, S3, listingOf, ollamaFound, threeModels } from './models-shell-harness.ts';
import { flowOf } from './tui-models-harness.ts';
import type { FlowHarness, Step } from './tui-models-harness.ts';

const NO_HEALTH = { models: {} };

const rowsOf = (listing: MomongaModelList, current?: string): string[] => modelListRows({ listing, current, health: NO_HEALTH, found: [], plan: [] }).rows.map((row) => row.label);

const listingWith = (context: TestContext, settings: unknown): MomongaModelList => listingOf(flowOf(context, settings, []).place.home);

const pickerOf = (harness: FlowHarness, connected: string[] = []) => {
  const { choose, promptText } = harness.context.overlays;
  return createPlanFlows({
    backend: { ...harness.context.backend, ...folderTrustFakes({ settingsPlace: () => ({ home: harness.place.home, projectDir: harness.place.home }), trust: undefined, trustItems: undefined, cwd: () => harness.place.home, record: () => undefined }), models: async () => (await harness.context.backend.modelList()).data } as unknown as TuiBackend,
    pick: async (request) => (await choose(request))?.index,
    choose,
    promptText,
    captureKey: async () => undefined,
    waiting: () => undefined,
    closeWaiting: () => undefined,
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
};

describe('the /model list (6.2)', () => {
  it('has one row per configured model, in the order of the file', (context) => {
    expect(rowsOf(listingWith(context, threeModels()))).toEqual(['ollama/gemma-3-4b    local', 'ollama/qwen3.8:27b   local', 'lmstudio/gemma-3-4b  local']);
  });

  it('shows the display name, then the models it falls back to when there are any', (context) => {
    expect(rowsOf(listingWith(context, threeModels({ fallback: ['lmstudio/gemma-3-4b', 'qwen3.8:27b'] })))).toEqual([
      'ollama/gemma-3-4b → lmstudio/gemma-3-4b → ollama/qwen3.8:27b  local',
      'ollama/qwen3.8:27b → lmstudio/gemma-3-4b                      local',
      'lmstudio/gemma-3-4b → ollama/qwen3.8:27b                      local',
    ]);
  });

  it("marks the session's model", (context) => {
    expect(rowsOf(listingWith(context, threeModels()), 'ollama/qwen3.8:27b')).toEqual(['ollama/gemma-3-4b             local', 'ollama/qwen3.8:27b (current)  local', 'lmstudio/gemma-3-4b           local']);
  });

  it('has no row that says default', (context) => {
    for (const settings of [threeModels(), threeModels({ start: 'qwen3.8:27b' }), S3]) {
      for (const row of rowsOf(listingWith(context, settings), 'ollama/qwen3.8:27b')) expect(row).not.toMatch(/default/i);
    }
  });

  it('shows the billing kind beside the row, and the state of a model that needs a sign-in', (context) => {
    const listing = listingWith(context, S3);
    expect(rowsOf(listing)).toEqual(['chatgpt/gpt-5.5 → openai/gpt-5.5  plan', 'openai/gpt-5.5                    metered']);
    const health = { models: { 'chatgpt/gpt-5.5': { ok: false, breaker: 'closed' as const, reason: 'sign_in_required' as const } } };
    expect(modelListRows({ listing, current: undefined, health, found: [], plan: [] }).rows.map((row) => row.label)).toEqual(['chatgpt/gpt-5.5 → openai/gpt-5.5  plan     sign in required', 'openai/gpt-5.5                    metered  -']);
  });

  it('shows the found models that are not configured below a separator, only after a search the user started; a chosen one is added and, with its numbers unknown, not switched to', async (context) => {
    const before = flowOf(context, threeModels(), []);
    await pickerOf(before).modelPicker(undefined);
    expect(before.picks()[0]?.rows).toEqual(['ollama/gemma-3-4b    local', 'ollama/qwen3.8:27b   local', 'lmstudio/gemma-3-4b  local', MODEL_SETTINGS_ROW]);

    const steps: Step[] = [{ pick: /^ollama\/devstral-small-2/ }, { pick: 'Yes' }];
    const after = flowOf(context, threeModels(), steps);
    after.context.found.remember(offeredServers([ollamaFound(OLLAMA_ADDRESS, ['qwen3.8:27b', 'devstral-small-2:latest'])]));
    const connected: string[] = [];
    await pickerOf(after, connected).modelPicker(undefined);
    expect(after.picks()[0]?.rows).toEqual(['ollama/gemma-3-4b        local', 'ollama/qwen3.8:27b       local', 'lmstudio/gemma-3-4b      local', 'Found on this computer', 'ollama/devstral-small-2  local', MODEL_SETTINGS_ROW]);
    expect(after.infos).toEqual(['Added ollama/devstral-small-2. It is used from the next request.', 'the numbers of this model are not known\nChoose a model with /model, or set one up through its Model settings… row.']);
    expect(connected).toEqual([]);
    expect((after.written() as { models: { connections: { models: { id: string }[] }[] } }).models.connections[0]?.models.map((model) => model.id)).toContain('devstral-small-2:latest');
  });

  it('opens with the no-model line and the Model settings row alone when no model is connected, and that row opens the Models screen', async (context) => {
    expect(START_ONE_TEXT).toContain(MODEL_SETTINGS_ROW);
    const harness = flowOf(context, {}, [{ pick: MODEL_SETTINGS_ROW }]);
    await pickerOf(harness).modelPicker(undefined);
    expect(harness.picks()[0]?.rows).toEqual([MODEL_SETTINGS_ROW]);
    expect(harness.picks()[0]?.lines).toEqual([messageOf('noModelConnected', 'tui')]);
    expect(harness.picks()[1]?.title).toBe(MODELS_TITLE);
    expect(harness.picks()[1]?.rows).toContain('Add a model');
    expect(harness.picks()[2]?.rows).toEqual([MODEL_SETTINGS_ROW]);
  });

  it('opens without asking any server', async (context) => {
    const harness = flowOf(context, threeModels(), []);
    await pickerOf(harness).modelPicker('ollama/qwen3.8:27b');
    expect(harness.detections).toEqual([]);
    expect(harness.phases).toEqual([]);
  });

  it('answers /model <text> that names two models with the sentence of the resolver, by display names', async (context) => {
    const harness = flowOf(context, threeModels(), []);
    const set: string[] = [];
    const slash = { ...harness.context, setModel: async (model: string) => void set.push(model), toast: harness.context.info } as unknown as SlashContext;
    await switchModel('gemma-3-4b', listingOf(harness.place.home).data, slash);
    expect(harness.infos).toEqual(['The model "gemma-3-4b" is served by two servers: ollama/gemma-3-4b, lmstudio/gemma-3-4b. Write one of them.']);
    expect(set).toEqual([]);
    await switchModel('qwen3.8:27b --start', listingOf(harness.place.home).data, slash);
    expect(set).toEqual(['ollama/qwen3.8:27b']);
    expect((harness.written() as { models: { start: string } }).models.start).toBe('ollama/qwen3.8:27b');
    expect(harness.infos.at(-1)).toBe('Starting model set to ollama/qwen3.8:27b');
  });
});
