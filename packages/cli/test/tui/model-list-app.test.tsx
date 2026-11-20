import { describe, expect, it, vi } from 'vitest';
import type { PlanModelsResponse, ReasoningCapability, TargetHealth, ToolCallingState } from '@momonga/protocol';
import type { ResolvedTuiSettings } from '@momonga/config';
import { App } from '../../src/tui/app.tsx';
import type { TuiBackend } from '../../src/tui/backend.ts';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import { account, fakePlanBackend, startPlan, submitLine } from '../fake-plan-gateway.tsx';
import type { FakePlanOptions, PlanTiming } from '../fake-plan-gateway.tsx';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import { KEYS, TEST_KEY_SETTLE_MS, TUI_TEST_TIMEOUT_MS, renderObservable, settleAtOnce, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { systemTiming } from '@momonga/foundation';
import { pollUntil } from '@momonga/testkit';
import { fakeScreenTerminal } from './screen-fakes.ts';
import { freshPlace, stored, writeSettings } from './settings-harness.tsx';
import type { Place } from './settings-harness.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const QWEN = 'ollama/qwen3.8:27b';
const LUNA = 'chatgpt/gpt-6-luna';
const REASONING: ReasoningCapability = { control: 'reasoning_effort', lowest: 'low' };
const SLUGS = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.2-nova', 'gpt-6.2-terra', 'gpt-6.2-luma', 'gpt-6.2-vela', 'gpt-6.2-orion', 'gpt-6.2-lyra', 'gpt-6.2-mira'];
const SIGN_IN: TargetHealth = { ok: false, breaker: 'closed', reason: 'sign_in_required' };

const catalogOf = (models: PlanModelsResponse['models']): Record<string, PlanModelsResponse> => ({ chatgpt: { readAt: '2026-11-10T00:00:00.000Z', models } });
const usable = (slug: string): PlanModelsResponse['models'][number] => ({ slug, displayName: slug.toUpperCase(), usable: true, contextWindow: 272000, maxOutputTokens: 128000 });

const APPROVED: FakePlanOptions = {
  session: { model: QWEN },
  models: [QWEN, LUNA],
  billing: { [QWEN]: 'local', [LUNA]: 'plan' },
  reasoning: { [QWEN]: REASONING, [LUNA]: REASONING },
  accounts: [account()],
  catalogs: catalogOf(SLUGS.map(usable)),
};

const HINT = 'enter to choose · up/down to move · type to filter · tab: also use at every start · esc: go back';

const APPROVED_BLOCK = [
  'Models',
  'a change applies from the next run',
  'filter:',
  '›  1. ollama/qwen3.8:27b (current)  local',
  '   2. gpt-6-luna                    plan',
  '   3. gpt-6.2-sol                   plan',
  '   4. gpt-6.2-astra                 plan',
  '   5. gpt-6.2-nova                  plan',
  '   6. gpt-6.2-terra                 plan',
  '   7. gpt-6.2-luma                  plan',
  '   8. gpt-6.2-vela                  plan',
  '   9. gpt-6.2-orion                 plan',
  '  10. gpt-6.2-lyra                  plan',
  '  11. gpt-6.2-mira                  plan',
  '  12. Model settings…',
  HINT,
].join('\n');

const LUNA_HIGHLIGHTED = APPROVED_BLOCK.replace('›  1. ollama/qwen3.8:27b (current)', '   1. ollama/qwen3.8:27b (current)').replace('   2. gpt-6-luna', '›  2. gpt-6-luna');

const lineOf = (line: string): string => line.replace(/^│ /, '').replace(/│$/, '').trimEnd();

const listBlock = (frame: string, title = 'Models'): string => {
  const lines = frame.split('\n').map(lineOf);
  const start = lines.indexOf(title);
  const end = lines.findIndex((line, index) => index > start && line.includes('esc: go back'));
  if (start === -1 || end === -1) throw new Error(`no ${title} list in:\n${frame}`);
  return lines.slice(start, end + 1).join('\n');
};

const ready = async (app: Instance): Promise<void> => {
  await untilFrame(app, 'mode: manual');
};

const openList = async (app: Instance): Promise<string> => {
  await ready(app);
  await submitLine(app, '/model');
  return listBlock(await untilFrame(app, (frame) => frame.includes('Model settings…') && frame.includes('esc: go back')));
};

const startReading = (options: FakePlanOptions, screenReader: Partial<ResolvedTuiSettings>) => {
  const backend = fakePlanBackend(options);
  const tuiSettings: TuiSettingsPort = {
    initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true, ...screenReader },
    save: async () => undefined,
  };
  const terminal = fakeScreenTerminal({ screen: 'scrollback', columns: 160, rows: 40 });
  const app = renderObservable(<App backend={backend as TuiBackend} terminal={terminal} initialMode={undefined} now={Date.now} timers={settleAtOnce(systemTiming)} keySettleMs={TEST_KEY_SETTLE_MS} tuiSettings={tuiSettings} onExit={() => undefined} />);
  return { app, backend };
};

describe('the rows of the /model list', () => {
  it('shows every model row as its name and its billing word in one aligned column, with no effort and no middle dot', async () => {
    const { app } = await startPlan(APPROVED);
    const block = await openList(app);
    expect(block).toBe(APPROVED_BLOCK);
    expect(block).not.toContain('effort');
    expect(block).not.toContain('·  ');
    expect(block).not.toContain('left/right');
    app.unmount();
  });

  it('adds the state column when a row has a state, with - on the rows without one, and shows a disabled plan model by its slug, its billing and its reason', async () => {
    const { app } = await startPlan({
      session: { model: QWEN },
      models: [LUNA, QWEN],
      chains: { [LUNA]: [LUNA, 'openai/gpt-6'] },
      billing: { [QWEN]: 'local', [LUNA]: 'plan' },
      health: { [LUNA]: SIGN_IN },
      accounts: [account()],
      catalogs: catalogOf([usable('gpt-6.2-sol'), { slug: 'gpt-odd', displayName: 'Odd', usable: false, reason: 'no context window reported' }]),
    });
    expect(await openList(app)).toBe(
      [
        'Models',
        'a change applies from the next run',
        '› 1. gpt-6-luna → openai/gpt-6     plan   sign in required',
        '  2. ollama/qwen3.8:27b (current)  local  -',
        '  3. gpt-6.2-sol                   plan   -',
        '  4. gpt-odd                       plan   no context window reported (unavailable)',
        '  5. Model settings…',
        '1-9 or enter to choose · up/down to move · tab: also use at every start · esc: go back',
      ].join('\n'),
    );
    app.unmount();
  });

  it('aligns names with wide characters by their display width', async () => {
    const wide = 'ollama/通义千问超大模型版本测试';
    const { app } = await startPlan({ session: { model: QWEN }, models: [QWEN, wide], billing: { [QWEN]: 'local', [wide]: 'local' } });
    expect(await openList(app)).toBe(
      [
        'Models',
        'a change applies from the next run',
        '› 1. ollama/qwen3.8:27b (current)     local',
        '  2. ollama/通义千问超大模型版本测试  local',
        '  3. Model settings…',
        '1-9 or enter to choose · up/down to move · tab: also use at every start · esc: go back',
      ].join('\n'),
    );
    app.unmount();
  });

  it('keeps the rows a typed filter leaves exactly as they were drawn before', async () => {
    const { app } = await startPlan(APPROVED);
    await openList(app);
    app.stdin.write('sol');
    const filtered = listBlock(await untilFrame(app, 'filter: sol'));
    expect(filtered).toBe(['Models', 'a change applies from the next run', 'filter: sol', '›  1. gpt-6.2-sol                   plan', HINT].join('\n'));
    app.unmount();
  });

  it('keeps the plan models when the typed filter is their provider name, which no row shows', async () => {
    const { app } = await startPlan(APPROVED);
    await openList(app);
    app.stdin.write('openai');
    const filtered = listBlock(await untilFrame(app, 'filter: openai'));
    expect(filtered).toBe(
      [
        'Models',
        'a change applies from the next run',
        'filter: openai',
        '›  1. gpt-6.2-sol                   plan',
        '   2. gpt-6.2-astra                 plan',
        '   3. gpt-6.2-nova                  plan',
        '   4. gpt-6.2-terra                 plan',
        '   5. gpt-6.2-luma                  plan',
        '   6. gpt-6.2-vela                  plan',
        '   7. gpt-6.2-orion                 plan',
        '   8. gpt-6.2-lyra                  plan',
        '   9. gpt-6.2-mira                  plan',
        HINT,
      ].join('\n'),
    );
    app.unmount();
  });

  it('keeps a plan model when the typed filter is its display name, which its row does not show', async () => {
    const { app } = await startPlan({ ...APPROVED, catalogs: catalogOf(SLUGS.map((slug) => (slug === 'gpt-6.2-sol' ? { ...usable(slug), displayName: 'Sol Prime' } : usable(slug)))) });
    await openList(app);
    app.stdin.write('prime');
    const filtered = listBlock(await untilFrame(app, 'filter: prime'));
    expect(filtered).toBe(['Models', 'a change applies from the next run', 'filter: prime', '›  1. gpt-6.2-sol                   plan', HINT].join('\n'));
    app.unmount();
  });

  it('leaves no model row when the typed filter is contained in nothing', async () => {
    const { app } = await startPlan(APPROVED);
    await openList(app);
    app.stdin.write('zzqx');
    const filtered = await untilFrame(app, 'filter: zzqx');
    expect(filtered).not.toContain('gpt-');
    expect(filtered).not.toContain('qwen');
    expect(filtered).not.toContain('Model settings');
    app.unmount();
  });

  it('keeps the state column and its - when a typed filter hides the only row with a state', async () => {
    const { app } = await startPlan({ ...APPROVED, health: { [LUNA]: SIGN_IN } });
    const before = await openList(app);
    expect(before).toContain('   3. gpt-6.2-sol                   plan   -');
    app.stdin.write('sol');
    const filtered = listBlock(await untilFrame(app, 'filter: sol'));
    expect(filtered).toBe(['Models', 'a change applies from the next run', 'filter: sol', '›  1. gpt-6.2-sol                   plan   -', HINT].join('\n'));
    app.unmount();
  });

  it('shows the same rows to a screen reader', async () => {
    const { app } = startReading(APPROVED, { screenReader: true });
    await ready(app);
    await submitLine(app, '/model');
    const frame = await untilFrame(app, (shown) => shown.includes('Model settings…') && shown.includes('esc: go back'));
    const lines = frame.split('\n').map((line) => line.trimEnd());
    const start = lines.indexOf('Models');
    const end = lines.findIndex((line, index) => index > start && line.includes('esc: go back'));
    expect(lines.slice(start, end + 1).join('\n')).toBe(
      [
        'Models',
        'a change applies from the next run',
        'selected: ollama/qwen3.8:27b (current)  local',
        'filter:',
        ' 1. ollama/qwen3.8:27b (current)  local',
        ' 2. gpt-6-luna                    plan',
        ' 3. gpt-6.2-sol                   plan',
        ' 4. gpt-6.2-astra                 plan',
        ' 5. gpt-6.2-nova                  plan',
        ' 6. gpt-6.2-terra                 plan',
        ' 7. gpt-6.2-luma                  plan',
        ' 8. gpt-6.2-vela                  plan',
        ' 9. gpt-6.2-orion                 plan',
        '10. gpt-6.2-lyra                  plan',
        '11. gpt-6.2-mira                  plan',
        '12. Model settings…',
        HINT,
      ].join('\n'),
    );
    app.unmount();
  });

  it('changes nothing when left or right is pressed on a row', async () => {
    const { app } = await startPlan(APPROVED);
    const before = await openList(app);
    app.stdin.write(`${KEYS.right}${KEYS.right}${KEYS.left}`);
    app.stdin.write(KEYS.down);
    await untilFrame(app, '›  2.');
    app.stdin.write(KEYS.up);
    const cleared = listBlock(await untilFrame(app, '›  1.'));
    expect(cleared).toBe(before);
    app.unmount();
  });
});

const SOL = 'chatgpt/gpt-6.2-sol';
const EFFORT_HINT = 'up/down to move · enter to choose · tab: this session only · esc: go back';
const EFFORT_BLOCK = ['Reasoning effort', '  1. low', '› 2. medium  in use', '  3. high', '  4. xhigh', EFFORT_HINT].join('\n');
const LOADING_BLOCK = 'Loading models…';
const UNAVAILABLE_MESSAGE = 'the model gpt-6-luna cannot be used yet: the settings give no context window and output limit for it';
const UNAVAILABLE_REMEDY = 'Choose a model with /model, or set one up through its Model settings… row.';

const switches = (backend: { calls: readonly string[] }): string[] => backend.calls.filter((call) => call.startsWith('model:'));
const effortCalls = (backend: { calls: readonly string[] }): string[] => backend.calls.filter((call) => call.startsWith('effort:'));
const shownLines = (frame: string): string[] => frame.split('\n').map(lineOf).filter((line) => line !== '');
const pickerShown = (frame: string): boolean => frame.includes('Reasoning effort') && frame.includes('tab: this session only');
const listShown = (frame: string): boolean => frame.includes('Model settings…') && frame.includes('esc: go back');
const loadingShown = (frame: string): boolean => shownLines(frame).includes(LOADING_BLOCK);
const notesOf = (output: string): string[] =>
  output
    .split('\n')
    .map(lineOf)
    .filter((line) => /^(model:|effort:|Starting model set|model information unavailable|the model gpt-6-luna|Choose a model with|PATCH |the settings could not)/.test(line.trim()))
    .map((line) => line.trim())
    .filter((line, index, all) => all.indexOf(line) === index);

const settled = (): Promise<void> => new Promise((resolve) => systemTiming.setTimeout(resolve, 300));

const chooseLuna = async (options: FakePlanOptions, key: string = KEYS.enter) => {
  const started = await startPlan({ ...APPROVED, ...options });
  await openList(started.app);
  started.app.stdin.write(`${KEYS.down}${key}`);
  return started;
};

const OTHER = 'scripted/other-model';

const chooseOther = async (key: string) => {
  const place = freshPlace();
  writeSettings(place.userFile, { models: { connections: [{ adapter: 'chat-completions', provider: 'scripted', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'other-model', capabilities: { contextWindow: 8192, maxOutputTokens: 1024, reasoning: REASONING } }] }] } });
  const started = await startPlan({ ...APPROVED, models: [QWEN, OTHER], reasoning: { ...APPROVED.reasoning, [OTHER]: REASONING }, catalogs: catalogOf([]), settingsPlace: { home: place.home, projectDir: place.project } });
  await openList(started.app);
  started.app.stdin.write(`${KEYS.down}${key}`);
  return { ...started, place };
};

type SettingsDocument = { models: { start?: string; connections: { models: { id: string; effort?: string }[] }[] } };

const savedEffortOf = (place: Place): string | undefined => (stored(place.userFile) as SettingsDocument).models.connections[0]?.models.find((entry) => entry.id === 'other-model')?.effort;

const startOf = (place: Place): string | undefined => (stored(place.userFile) as SettingsDocument).models.start;

const chooseSol = async (options: FakePlanOptions) => {
  const started = await startPlan({ ...APPROVED, probing: [SOL], ...options });
  await openList(started.app);
  started.app.stdin.write(`${KEYS.down}${KEYS.down}${KEYS.enter}`);
  return started;
};

describe('choosing a model in the /model list switches nothing until its effort is chosen', () => {
  it('opens the effort picker without a switch, then switches model and effort together and saves the effort', async () => {
    const { app, backend, place } = await chooseOther(KEYS.enter);
    const picker = await untilFrame(app, pickerShown);
    expect(listBlock(picker, 'Reasoning effort')).toBe(EFFORT_BLOCK);
    expect(switches(backend)).toEqual([]);
    app.stdin.write(KEYS.enter);
    const output = await untilOutput(app, 'model: other-model (effort: medium); applies from the next run');
    expect(switches(backend)).toEqual([`model:${OTHER} effort:medium`]);
    expect(effortCalls(backend)).toEqual([]);
    expect(notesOf(app.frames.join('\n'))).toEqual(['model: other-model (effort: medium); applies from the next run']);
    expect(savedEffortOf(place)).toBe('medium');
    expect(app.lastFrame()).not.toContain('Reasoning effort');
    app.unmount();
  });

  it('esc on the effort picker shows the model list again as it was and switches nothing', async () => {
    const { app, backend } = await chooseLuna({});
    await untilFrame(app, pickerShown);
    app.stdin.write(KEYS.escape);
    const again = await untilFrame(app, (frame) => listShown(frame) && !pickerShown(frame));
    expect(listBlock(again)).toBe(LUNA_HIGHLIGHTED);
    expect(switches(backend)).toEqual([]);
    expect(effortCalls(backend)).toEqual([]);
    expect(notesOf(app.lastFrame() ?? '')).toEqual([]);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, pickerShown);
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'model: gpt-6-luna (effort: medium); applies from the next run');
    expect(switches(backend)).toEqual([`model:${LUNA} effort:medium`]);
    app.unmount();
  });

  it('esc while a configured model is read shows the model list again with that model highlighted', async () => {
    const pending = Promise.withResolvers<void>();
    const { app, backend } = await chooseLuna({ probing: [LUNA], modelPending: pending.promise });
    await untilFrame(app, loadingShown);
    app.stdin.write(KEYS.escape);
    const again = await untilFrame(app, (frame) => listShown(frame) && !loadingShown(frame));
    expect(listBlock(again)).toBe(LUNA_HIGHLIGHTED);
    pending.resolve();
    expect(switches(backend)).toEqual([]);
    app.unmount();
  });

  it('tab on the list takes effect only when the effort is chosen', async () => {
    const { app, backend, place } = await chooseOther(KEYS.tab);
    const picker = await untilFrame(app, pickerShown);
    expect(app.frames.join('\n')).not.toContain('Starting model set to');
    expect(startOf(place)).toBeUndefined();
    expect(switches(backend)).toEqual([]);
    app.stdin.write(KEYS.tab);
    const output = await untilOutput(app, 'model: other-model (effort: medium); applies from the next run');
    await untilOutput(app, 'Starting model set to other-model');
    expect(output).toContain('model: other-model (effort: medium); applies from the next run');
    expect(picker).toContain('Reasoning effort');
    expect(startOf(place)).toBe(OTHER);
    expect(switches(backend)).toEqual([`model:${OTHER} effort:medium`]);
    expect(notesOf(app.frames.join('\n')).filter((line) => !line.startsWith('Starting model set'))).toEqual(['model: other-model (effort: medium); applies from the next run']);
    expect(savedEffortOf(place)).toBeUndefined();
    app.unmount();
  });

  it('tab on the list and esc on the effort picker set no starting model', async () => {
    const { app, backend, place } = await chooseOther(KEYS.tab);
    await untilFrame(app, pickerShown);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (frame) => listShown(frame) && !pickerShown(frame));
    expect(app.frames.join('\n')).not.toContain('Starting model set to');
    expect(startOf(place)).toBeUndefined();
    expect(switches(backend)).toEqual([]);
    app.unmount();
  });

  it('while a run is working, the one line says that run keeps its model', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { models: { connections: [{ adapter: 'chat-completions', provider: 'scripted', baseUrl: 'http://127.0.0.1:9/v1', models: [{ id: 'other-model', capabilities: { contextWindow: 8192, maxOutputTokens: 1024, reasoning: REASONING } }] }] } });
    const { app, backend } = await startPlan({ ...APPROVED, models: [QWEN, OTHER], reasoning: { ...APPROVED.reasoning, [OTHER]: REASONING }, catalogs: catalogOf([]), settingsPlace: { home: place.home, projectDir: place.project } });
    await ready(app);
    await submitLine(app, 'long task');
    await pollUntil(() => backend.started.length === 1, { description: 'the run is started', boundMs: 5000 });
    await submitLine(app, '/model');
    await untilFrame(app, listShown);
    app.stdin.write(`${KEYS.down}${KEYS.enter}`);
    await untilFrame(app, pickerShown);
    expect(switches(backend)).toEqual([]);
    app.stdin.write(KEYS.enter);
    const line = 'model: other-model (effort: medium); the run that is working keeps ollama/qwen3.8:27b, the next run uses other-model';
    await untilOutput(app, line);
    expect(switches(backend)).toEqual([`model:${OTHER} effort:medium`]);
    expect(notesOf(app.frames.join('\n'))).toEqual([line]);
    app.unmount();
  });

  it('with no session open, opens none before the effort is chosen, then opens it with the chosen model and applies the effort', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [account()], catalogs: catalogOf([usable('gpt-6.2-sol')]), reasoning: { [SOL]: REASONING } });
    await untilFrame(app, 'Choose a model of chatgpt');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (frame) => frame.includes('no model connected · /login') && !frame.includes('Choose a model of chatgpt'));
    await submitLine(app, '/model');
    await untilFrame(app, listShown);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, pickerShown);
    expect(backend.calls.filter((call) => call === 'openSession' || call.startsWith('model:') || call.startsWith('effort:'))).toEqual([]);
    app.stdin.write(KEYS.tab);
    await untilFrame(app, (frame) => frame.includes('mode: manual') && !pickerShown(frame));
    const line = 'model: gpt-6.2-sol (effort: medium); applies from the next run';
    await untilOutput(app, line);
    expect(backend.calls.filter((call) => call === 'openSession' || call.startsWith('model:') || call.startsWith('effort:'))).toEqual(['openSession']);
    expect(backend.opened).toEqual([{ model: SOL, permissionMode: undefined, effort: 'medium' }]);
    expect(notesOf(app.frames.join('\n'))).toEqual([line]);
    expect(app.lastFrame()).toContain('context: 0% · gpt-6.2-sol (effort: medium)');
    app.unmount();
  });

  it('with no session open, a failed open leaves no session open and shows only the error row', async () => {
    const { app, backend } = await startPlan({ models: [], accounts: [account()], catalogs: catalogOf([usable('gpt-6.2-sol')]), reasoning: { [SOL]: REASONING }, openSessionFailure: new Error('POST /v1/sessions answered 500: the daemon refused') });
    await untilFrame(app, 'Choose a model of chatgpt');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (frame) => frame.includes('no model connected · /login') && !frame.includes('Choose a model of chatgpt'));
    await submitLine(app, '/model');
    await untilFrame(app, listShown);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, pickerShown);
    app.stdin.write(KEYS.tab);
    const output = await untilOutput(app, 'POST /v1/sessions answered 500: the daemon refused');
    expect(backend.opened).toEqual([{ model: SOL, permissionMode: undefined, effort: 'medium' }]);
    expect(notesOf(output)).toEqual([]);
    expect(backend.calls.filter((call) => call.startsWith('effort:') || call.startsWith('model:'))).toEqual([]);
    expect(app.lastFrame()).toContain('no model connected · /login');
    app.unmount();
  });

  it('a failed effort write is the error shown even when the model line cannot be read', async () => {
    const { app, backend } = await chooseLuna({ modelsLockFailure: new Error('the settings could not be locked') });
    await untilFrame(app, pickerShown);
    const models = backend.models;
    let reads = 0;
    backend.models = async () => {
      reads += 1;
      if (reads === 1) return models();
      throw new Error('the listing could not be read');
    };
    app.stdin.write(KEYS.enter);
    const output = await untilOutput(app, 'the settings could not be locked');
    expect(switches(backend)).toEqual([`model:${LUNA} effort:medium`]);
    expect(output).not.toContain('the listing could not be read');
    app.unmount();
  });

  it('a switch whose model line cannot be read shows the error of that read', async () => {
    const { app, backend } = await chooseLuna({});
    await untilFrame(app, pickerShown);
    const models = backend.models;
    let reads = 0;
    backend.models = async () => {
      reads += 1;
      if (reads === 1) return models();
      throw new Error('the listing could not be read');
    };
    app.stdin.write(KEYS.tab);
    const output = await untilOutput(app, 'the listing could not be read');
    expect(switches(backend)).toEqual([`model:${LUNA} effort:medium`]);
    expect(notesOf(output)).toEqual([]);
    app.unmount();
  });

  it('esc right after enter, while the listing is still read, shows the list again with that row highlighted and leaves the working run alone', async () => {
    const { app, backend } = await startPlan(APPROVED);
    await ready(app);
    await submitLine(app, 'long task');
    await pollUntil(() => backend.started.length === 1, { description: 'the run is started', boundMs: 5000 });
    await submitLine(app, '/model');
    await untilFrame(app, listShown);
    const held = Promise.withResolvers<void>();
    const models = backend.models;
    backend.models = async () => {
      await held.promise;
      return models();
    };
    app.stdin.write(`${KEYS.down}${KEYS.enter}`);
    await untilFrame(app, loadingShown);
    app.stdin.write(KEYS.escape);
    const again = await untilFrame(app, (frame) => listShown(frame) && !loadingShown(frame));
    held.resolve();
    expect(listBlock(again)).toBe(LUNA_HIGHLIGHTED);
    expect(switches(backend)).toEqual([]);
    expect(backend.calls.filter((call) => call.startsWith('cancel:'))).toEqual([]);
    app.unmount();
  });

  it('a listing read that fails while Loading models… is shown is not switched to: the warning is shown once and the list is closed', async () => {
    const { app, backend } = await startPlan(APPROVED);
    await openList(app);
    const held = Promise.withResolvers<void>();
    backend.models = async () => {
      await held.promise;
      throw new Error('the listing could not be read');
    };
    app.stdin.write(`${KEYS.down}${KEYS.enter}`);
    await untilFrame(app, loadingShown);
    held.resolve();
    const output = await untilOutput(app, 'model information unavailable: the listing could not be read');
    await untilFrame(app, (frame) => !loadingShown(frame) && !listShown(frame) && frame.includes('mode: manual'));
    await settled();
    expect(notesOf(app.frames.join('\n'))).toEqual(['model information unavailable: the listing could not be read']);
    expect(output.split('model information unavailable').length - 1).toBe(1);
    expect(switches(backend)).toEqual([]);
    app.unmount();
  });

  it('a second enter while the listing is still read does not switch the model', async () => {
    const { app, backend } = await startPlan(APPROVED);
    await openList(app);
    const held = Promise.withResolvers<void>();
    const models = backend.models;
    backend.models = async () => {
      await held.promise;
      return models();
    };
    app.stdin.write(`${KEYS.down}${KEYS.enter}`);
    await untilFrame(app, loadingShown);
    app.stdin.write(KEYS.enter);
    held.resolve();
    const picker = await untilFrame(app, pickerShown);
    expect(listBlock(picker, 'Reasoning effort')).toBe(EFFORT_BLOCK);
    expect(switches(backend)).toEqual([]);
    app.unmount();
  });

  it('a model without a reasoning control chosen while the session has an effort shows only the model line', async () => {
    const { app, backend } = await chooseLuna({ session: { model: QWEN, effort: 'high' }, reasoning: { [QWEN]: REASONING } });
    const line = 'model: gpt-6-luna (effort: not available); applies from the next run';
    await untilOutput(app, line);
    await untilFrame(app, 'gpt-6-luna');
    await settled();
    expect(switches(backend)).toEqual([`model:${LUNA}`]);
    expect(notesOf(app.frames.join('\n'))).toEqual([line]);
    expect(app.frames.join('\n')).not.toContain('was chosen');
    app.unmount();
  });

  it('a model whose reasoning was not known when it was chosen shows only the model line after the switch', async () => {
    const pending = Promise.withResolvers<void>();
    const { app } = await chooseSol({ reasoning: { ...APPROVED.reasoning, [SOL]: REASONING }, modelPending: pending.promise });
    await untilFrame(app, loadingShown);
    pending.resolve();
    await untilFrame(app, pickerShown);
    app.stdin.write(KEYS.tab);
    const line = 'model: gpt-6.2-sol (effort: medium); applies from the next run';
    await untilOutput(app, line);
    await settled();
    expect(notesOf(app.frames.join('\n'))).toEqual([line]);
    expect(app.frames.join('\n')).not.toContain('was chosen');
    app.unmount();
  });

  it('a model information read failing right after a successful switch', async () => {
    const { app } = await chooseLuna({ sessionModelFailures: { [LUNA]: new Error('the gateway is gone') } });
    await untilFrame(app, pickerShown);
    app.stdin.write(KEYS.tab);
    const line = 'model: gpt-6-luna (effort: medium); applies from the next run';
    await untilOutput(app, line);
    await settled();
    expect(notesOf(app.frames.join('\n'))).toEqual(['model information unavailable: the gateway is gone', line]);
    app.unmount();
  });

  it('an unavailable model is not switched to: its notice is shown once and the list is closed', async () => {
    const unavailable: ToolCallingState = { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: UNAVAILABLE_MESSAGE, param: 'model' };
    const { app, backend } = await chooseLuna({ toolCalling: { [LUNA]: unavailable } });
    const output = await untilOutput(app, UNAVAILABLE_REMEDY);
    await untilFrame(app, (frame) => !listShown(frame) && frame.includes('mode: manual'));
    expect(notesOf(output)).toEqual([UNAVAILABLE_MESSAGE, UNAVAILABLE_REMEDY]);
    expect(output.split(UNAVAILABLE_REMEDY).length - 1).toBe(1);
    expect(switches(backend)).toEqual([]);
    expect(app.lastFrame()).not.toContain('Reasoning effort');
    app.unmount();
  });

  it('a failed switch after the effort is chosen keeps the earlier model, writes no effort and shows the error', async () => {
    const { app, backend } = await chooseLuna({ setModelFailure: new Error('PATCH /v1/sessions/s-1 answered 500: the daemon refused') });
    await untilFrame(app, pickerShown);
    app.stdin.write(KEYS.enter);
    const output = await untilOutput(app, 'PATCH /v1/sessions/s-1 answered 500: the daemon refused');
    expect(notesOf(output)).toEqual(['PATCH /v1/sessions/s-1 answered 500: the daemon refused']);
    expect((await backend.models()).find((entry) => entry.id === LUNA)?.effort).toBeUndefined();
    expect(app.lastFrame()).not.toContain('Reasoning effort');
    await submitLine(app, '/model');
    expect(listBlock(await untilFrame(app, listShown))).toBe(APPROVED_BLOCK);
    app.unmount();
  });

  it('a failed effort write keeps the switched model and effort and shows the model line and the error', async () => {
    const { app, backend } = await chooseLuna({ modelsLockFailure: new Error('the settings could not be locked') });
    await untilFrame(app, pickerShown);
    app.stdin.write(KEYS.enter);
    const output = await untilOutput(app, 'the settings could not be locked');
    expect(switches(backend)).toEqual([`model:${LUNA} effort:medium`]);
    expect(notesOf(output)).toEqual(['model: gpt-6-luna (effort: medium); applies from the next run', 'the settings could not be locked']);
    app.unmount();
  });
});

describe('the effort step after a plan model that is not configured is chosen', () => {
  it('shows only Loading models… while the information of the added model is read, then opens the effort picker without a switch', async () => {
    const pending = Promise.withResolvers<void>();
    const { app, backend } = await chooseSol({ reasoning: { ...APPROVED.reasoning, [SOL]: REASONING }, modelPending: pending.promise });
    const waiting = await untilFrame(app, loadingShown);
    expect(shownLines(waiting)).toEqual([LOADING_BLOCK]);
    expect(switches(backend)).toEqual([]);
    pending.resolve();
    const picker = await untilFrame(app, pickerShown);
    expect(listBlock(picker, 'Reasoning effort')).toBe(EFFORT_BLOCK);
    expect(switches(backend)).toEqual([]);
    app.stdin.write(KEYS.enter);
    const output = await untilOutput(app, 'model: gpt-6.2-sol (effort: medium); applies from the next run');
    expect(switches(backend)).toEqual([`model:${SOL} effort:medium`]);
    expect(output.split('model: gpt-6.2-sol').length - 1).toBe(1);
    app.unmount();
  });

  it('switches a model with no reasoning control once its information is read', async () => {
    const pending = Promise.withResolvers<void>();
    const { app, backend } = await chooseSol({ reasoning: {}, modelPending: pending.promise });
    await untilFrame(app, loadingShown);
    expect(switches(backend)).toEqual([]);
    pending.resolve();
    const output = await untilOutput(app, 'model: gpt-6.2-sol (effort: not available); applies from the next run');
    expect(switches(backend)).toEqual([`model:${SOL}`]);
    expect(notesOf(output)).toEqual(['model: gpt-6.2-sol (effort: not available); applies from the next run']);
    expect(output).not.toContain('Reasoning effort');
    app.unmount();
  });

  it('esc during Loading models… shows the model list again, the added model stays added and nothing is switched', async () => {
    const pending = Promise.withResolvers<void>();
    const { app, backend } = await chooseSol({ reasoning: { ...APPROVED.reasoning, [SOL]: REASONING }, modelPending: pending.promise });
    await untilFrame(app, loadingShown);
    app.stdin.write(KEYS.escape);
    const again = await untilFrame(app, (frame) => listShown(frame) && !loadingShown(frame));
    expect(listBlock(again)).toBe(
      [
        'Models',
        'a change applies from the next run',
        'filter:',
        '   1. ollama/qwen3.8:27b (current)  local',
        '   2. gpt-6-luna                    plan',
        '›  3. gpt-6.2-sol                   metered',
        '   4. gpt-6.2-astra                 plan',
        '   5. gpt-6.2-nova                  plan',
        '   6. gpt-6.2-terra                 plan',
        '   7. gpt-6.2-luma                  plan',
        '   8. gpt-6.2-vela                  plan',
        '   9. gpt-6.2-orion                 plan',
        '  10. gpt-6.2-lyra                  plan',
        '  11. gpt-6.2-mira                  plan',
        '  12. Model settings…',
        HINT,
      ].join('\n'),
    );
    expect((await backend.models()).some((entry) => entry.id === SOL)).toBe(true);
    pending.resolve();
    expect(switches(backend)).toEqual([]);
    expect(notesOf(app.lastFrame() ?? '')).toEqual([]);
    app.stdin.write(KEYS.enter);
    const picker = await untilFrame(app, pickerShown);
    expect(listBlock(picker, 'Reasoning effort')).toBe(EFFORT_BLOCK);
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'model: gpt-6.2-sol (effort: medium); applies from the next run');
    expect(switches(backend)).toEqual([`model:${SOL} effort:medium`]);
    app.unmount();
  });

  it('a model whose information cannot be read is not switched to: the warning is shown once and the list is closed', async () => {
    const { app, backend } = await chooseSol({ reasoning: { ...APPROVED.reasoning, [SOL]: REASONING }, modelOfFailures: { [SOL]: new Error('the probe failed') } });
    const output = await untilOutput(app, 'model information unavailable: the probe failed');
    await untilFrame(app, (frame) => !loadingShown(frame) && frame.includes('mode: manual'));
    expect(notesOf(output)).toEqual(['model information unavailable: the probe failed']);
    expect(output.split('model information unavailable').length - 1).toBe(1);
    expect(switches(backend)).toEqual([]);
    expect(app.lastFrame()).not.toContain('Reasoning effort');
    app.unmount();
  });
});

describe('the /model flow with the timing of the real program', () => {
  const REAL: PlanTiming = { now: Date.now, timers: systemTiming, keySettleMs: KEY_SETTLE_MS };
  const LISTING_MS = 30;
  const pause = (ms: number): Promise<void> => new Promise((resolve) => systemTiming.setTimeout(resolve, ms));

  const listOpenAtRealTiming = async () => {
    const started = await startPlan(APPROVED, {}, {}, REAL);
    await ready(started.app);
    await submitLine(started.app, '/model');
    await untilFrame(started.app, listShown);
    await pause(KEY_SETTLE_MS * 2);
    const models = started.backend.models;
    started.backend.models = async () => {
      await pause(LISTING_MS);
      return models();
    };
    return started;
  };

  it('enter on the level marked in use switches the model with that level', async () => {
    const { app, backend } = await listOpenAtRealTiming();
    app.stdin.write(`${KEYS.down}${KEYS.enter}`);
    await untilFrame(app, pickerShown);
    await pause(KEY_SETTLE_MS * 4);
    app.stdin.write(KEYS.enter);
    await untilOutput(app, 'model: gpt-6-luna (effort: medium); applies from the next run');
    expect(switches(backend)).toEqual([`model:${LUNA} effort:medium`]);
    app.unmount();
  });

  for (const wait of [0, 50, 100, 300]) {
    it(`enter ${wait} ms after the effort picker appears on the level marked in use switches the model`, async () => {
      const { app, backend } = await listOpenAtRealTiming();
      app.stdin.write(`${KEYS.down}${KEYS.enter}`);
      await untilFrame(app, pickerShown);
      if (wait > 0) await pause(wait);
      app.stdin.write(KEYS.enter);
      await pause(1500);
      expect(switches(backend)).toEqual([`model:${LUNA} effort:medium`]);
      app.unmount();
    });
  }

  for (const gap of [0, 20, 60]) {
    it(`esc ${gap} ms after enter shows the model list again with the chosen row highlighted`, async () => {
      const { app, backend } = await listOpenAtRealTiming();
      app.stdin.write(`${KEYS.down}${KEYS.enter}`);
      if (gap > 0) await pause(gap);
      app.stdin.write(KEYS.escape);
      await pause(1500);
      const frame = app.lastFrame() ?? '';
      expect(pickerShown(frame)).toBe(false);
      expect(listBlock(frame)).toBe(LUNA_HIGHLIGHTED);
      expect(switches(backend)).toEqual([]);
      app.stdin.write(KEYS.enter);
      await untilFrame(app, pickerShown);
      await pause(KEY_SETTLE_MS * 2);
      app.stdin.write(KEYS.enter);
      await untilOutput(app, 'model: gpt-6-luna (effort: medium); applies from the next run');
      expect(switches(backend)).toEqual([`model:${LUNA} effort:medium`]);
      app.unmount();
    });
  }

  it('esc on the effort picker shown right after a quick enter returns to the list', async () => {
    const { app, backend } = await listOpenAtRealTiming();
    app.stdin.write(`${KEYS.down}${KEYS.enter}`);
    await untilFrame(app, pickerShown);
    await pause(1500);
    app.stdin.write(KEYS.escape);
    const again = await untilFrame(app, (frame) => listShown(frame) && !pickerShown(frame));
    expect(listBlock(again)).toBe(LUNA_HIGHLIGHTED);
    expect(switches(backend)).toEqual([]);
    app.unmount();
  });

  const burst = async (app: Instance, keys: readonly (readonly [string, number])[]): Promise<void> => {
    for (const [key, gap] of keys) {
      if (gap > 0) await pause(gap);
      app.stdin.write(key);
    }
  };

  const withRun = async (started: Awaited<ReturnType<typeof listOpenAtRealTiming>>, working: boolean): Promise<void> => {
    if (!working) return;
    started.app.stdin.write(KEYS.escape);
    await untilFrame(started.app, (frame) => !listShown(frame));
    await submitLine(started.app, 'long task');
    await pollUntil(() => started.backend.started.length === 1, { description: 'the run is started', boundMs: 5000 });
    await submitLine(started.app, '/model');
    await untilFrame(started.app, listShown);
    await pause(KEY_SETTLE_MS * 2);
  };

  const cancels = (backend: { calls: readonly string[] }): string[] => backend.calls.filter((call) => call.startsWith('cancel:'));

  for (const working of [false, true]) {
    for (const gap of [0, 20, 60, 150]) {
      const run = working ? ' while a run is working' : '';

      it(`enter then esc ${gap} ms later${run} shows the list again with the chosen row highlighted`, async () => {
        const started = await listOpenAtRealTiming();
        await withRun(started, working);
        await burst(started.app, [[KEYS.down, 0], [KEYS.enter, 0], [KEYS.escape, gap]]);
        await pause(1500);
        expect(listBlock(started.app.lastFrame() ?? '')).toBe(LUNA_HIGHLIGHTED);
        expect(switches(started.backend)).toEqual([]);
        expect(cancels(started.backend)).toEqual([]);
        started.app.unmount();
      });

      it(`enter then enter ${gap} ms later${run} switches at most once and leaves nothing stuck`, async () => {
        const started = await listOpenAtRealTiming();
        await withRun(started, working);
        await burst(started.app, [[KEYS.down, 0], [KEYS.enter, 0], [KEYS.enter, gap]]);
        await pause(1500);
        const frame = started.app.lastFrame() ?? '';
        if (switches(started.backend).length === 0) {
          expect(pickerShown(frame)).toBe(true);
          started.app.stdin.write(KEYS.escape);
          expect(listBlock(await untilFrame(started.app, (now) => listShown(now) && !pickerShown(now)))).toBe(LUNA_HIGHLIGHTED);
        } else expect(switches(started.backend)).toEqual([`model:${LUNA} effort:medium`]);
        expect(cancels(started.backend)).toEqual([]);
        started.app.unmount();
      });

      it(`esc on the effort picker then esc ${gap} ms later${run} closes the list and switches nothing`, async () => {
        const started = await listOpenAtRealTiming();
        await withRun(started, working);
        await burst(started.app, [[KEYS.down, 0], [KEYS.enter, 0]]);
        await untilFrame(started.app, pickerShown);
        await burst(started.app, [[KEYS.escape, 0], [KEYS.escape, gap]]);
        await pause(1500);
        const frame = started.app.lastFrame() ?? '';
        expect(pickerShown(frame)).toBe(false);
        expect(listShown(frame)).toBe(false);
        expect(switches(started.backend)).toEqual([]);
        expect(cancels(started.backend)).toEqual([]);
        started.app.unmount();
      });

      it(`enter then tab ${gap} ms later${run} switches at most once, for this session only`, async () => {
        const started = await listOpenAtRealTiming();
        await withRun(started, working);
        await burst(started.app, [[KEYS.down, 0], [KEYS.enter, 0], [KEYS.tab, gap]]);
        await pause(1500);
        const frame = started.app.lastFrame() ?? '';
        if (switches(started.backend).length === 0) expect(pickerShown(frame)).toBe(true);
        else expect(switches(started.backend)).toEqual([`model:${LUNA} effort:medium`]);
        expect(cancels(started.backend)).toEqual([]);
        started.app.unmount();
      });
    }
  }
});

