import { describe, expect, it, vi } from 'vitest';
import type { PlanModelsResponse, ReasoningCapability, TargetHealth } from '@momonga/protocol';
import type { ResolvedTuiSettings } from '@momonga/config';
import { App } from '../../src/tui/app.tsx';
import type { TuiBackend } from '../../src/tui/backend.ts';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import { account, fakePlanBackend, startPlan, submitLine } from '../fake-plan-gateway.tsx';
import type { FakePlanOptions } from '../fake-plan-gateway.tsx';
import { KEYS, TEST_KEY_SETTLE_MS, TUI_TEST_TIMEOUT_MS, renderObservable, settleAtOnce, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { systemTiming } from '@momonga/foundation';
import { fakeScreenTerminal } from './screen-fakes.ts';

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
    expect(filtered).toBe(['Models', 'a change applies from the next run', 'filter: sol', '› 1. gpt-6.2-sol                   plan', HINT].join('\n'));
    app.unmount();
  });

  it('keeps the state column and its - when a typed filter hides the only row with a state', async () => {
    const { app } = await startPlan({ ...APPROVED, health: { [LUNA]: SIGN_IN } });
    const before = await openList(app);
    expect(before).toContain('   3. gpt-6.2-sol                   plan   -');
    app.stdin.write('sol');
    const filtered = listBlock(await untilFrame(app, 'filter: sol'));
    expect(filtered).toBe(['Models', 'a change applies from the next run', 'filter: sol', '› 1. gpt-6.2-sol                   plan   -', HINT].join('\n'));
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

describe('the effort step after a configured model is chosen', () => {
  it('keeps the level and the chosen model when the effort picker is left with esc', async () => {
    const { app, backend } = await startPlan(APPROVED);
    await openList(app);
    app.stdin.write(`${KEYS.down}${KEYS.enter}`);
    await untilFrame(app, (frame) => frame.includes('Reasoning effort') && frame.includes('tab: this session only'));
    await backend.called(`model:${LUNA}`);
    app.stdin.write(KEYS.escape);
    await untilOutput(app, 'model: gpt-6-luna · effort: medium; applies from the next run');
    expect(backend.calls.filter((call) => call.startsWith('effort:'))).toEqual([]);
    expect(app.lastFrame()).not.toContain('Reasoning effort');
    app.unmount();
  });
});

describe('the effort step after a plan model that is not configured is chosen', () => {
  it('adds and connects the model, then opens the reasoning effort picker for it; esc keeps the level and the model line follows once', async () => {
    const { app, backend } = await startPlan({ ...APPROVED, reasoning: { ...APPROVED.reasoning, 'chatgpt/gpt-6.2-sol': REASONING } });
    await openList(app);
    app.stdin.write(`${KEYS.down}${KEYS.down}${KEYS.enter}`);
    const picker = await untilFrame(app, (frame) => frame.includes('Reasoning effort') && frame.includes('tab: this session only'));
    expect(listBlock(picker, 'Reasoning effort')).toContain('medium  in use');
    await backend.called('model:chatgpt/gpt-6.2-sol');
    expect(backend.planCalls.some((call) => call.route === 'accounts/chatgpt/targets')).toBe(true);
    app.stdin.write(KEYS.escape);
    const output = await untilOutput(app, 'model: gpt-6.2-sol · effort: medium; applies from the next run');
    expect(output.split('model: gpt-6.2-sol').length - 1).toBe(1);
    expect(backend.calls.filter((call) => call.startsWith('effort:'))).toEqual([]);
    app.unmount();
  });

  const SOL = 'chatgpt/gpt-6.2-sol';

  const chosenWhileMeasured = async (options: FakePlanOptions) => {
    const started = await startPlan({ ...APPROVED, probing: [SOL], ...options });
    await openList(started.app);
    started.app.stdin.write(`${KEYS.down}${KEYS.down}${KEYS.enter}`);
    await started.backend.called(`model:${SOL}`);
    return started;
  };

  const LOADING_BLOCK = 'Loading models…';

  const loadingBlockOf = (frame: string): string => {
    const lines = frame.split('\n').map(lineOf);
    const start = lines.indexOf(LOADING_BLOCK);
    return start === -1 ? '' : lines.slice(start, start + 2).join('\n').trimEnd();
  };

  it('shows the loading row while the capabilities of the added model are not loaded, then opens the effort picker', async () => {
    const pending = Promise.withResolvers<void>();
    const { app } = await chosenWhileMeasured({ reasoning: { ...APPROVED.reasoning, [SOL]: REASONING }, modelPending: pending.promise });
    const waiting = await untilFrame(app, (frame) => loadingBlockOf(frame) === LOADING_BLOCK);
    expect(loadingBlockOf(waiting)).toBe(LOADING_BLOCK);
    expect(waiting).not.toContain('reading…');
    expect(waiting).not.toContain('esc cancels');
    expect(waiting.split('\n').map(lineOf).filter((line) => line !== '')).toEqual([LOADING_BLOCK]);
    expect(waiting).not.toContain('Reasoning effort');
    pending.resolve();
    const picker = await untilFrame(app, (frame) => frame.includes('Reasoning effort') && frame.includes('tab: this session only'));
    expect(listBlock(picker, 'Reasoning effort')).toBe(['Reasoning effort', '  1. low', '› 2. medium  in use', '  3. high', '  4. xhigh', 'up/down to move · enter to choose · tab: this session only · esc: go back'].join('\n'));
    expect(picker).not.toContain('reading…');
    app.unmount();
  });

  it('opens nothing more when the loaded model has no reasoning control', async () => {
    const pending = Promise.withResolvers<void>();
    const { app } = await chosenWhileMeasured({ reasoning: {}, modelPending: pending.promise });
    await untilFrame(app, (frame) => loadingBlockOf(frame) === LOADING_BLOCK);
    pending.resolve();
    const output = await untilOutput(app, 'model: gpt-6.2-sol · effort: not available; applies from the next run');
    expect(output).not.toContain('Reasoning effort');
    expect(app.lastFrame()).not.toContain('reading…');
    app.unmount();
  });

  it('ends the wait when the model information cannot be read, shows what is shown for that failure, and opens no picker', async () => {
    const { app } = await chosenWhileMeasured({ reasoning: { ...APPROVED.reasoning, [SOL]: REASONING }, modelFailure: new Error('the probe failed') });
    const output = await untilOutput(app, 'model information unavailable: the probe failed');
    const after = await untilOutput(app, 'model: gpt-6.2-sol; applies from the next run');
    expect(output).not.toContain('Reasoning effort');
    expect(after).not.toContain('are not known yet');
    expect(app.lastFrame()).not.toContain('reading…');
    app.unmount();
  });

  it('ends the wait on the cancel key: the model stays chosen and no picker opens', async () => {
    const pending = Promise.withResolvers<void>();
    const { app, backend } = await chosenWhileMeasured({ reasoning: { ...APPROVED.reasoning, [SOL]: REASONING }, modelPending: pending.promise });
    await untilFrame(app, (frame) => loadingBlockOf(frame) === LOADING_BLOCK);
    app.stdin.write(KEYS.escape);
    await untilOutput(app, 'model: gpt-6.2-sol; applies from the next run');
    pending.resolve();
    await untilFrame(app, 'mode: manual');
    expect(app.lastFrame()).not.toContain('Reasoning effort');
    expect(backend.calls).toContain(`model:${SOL}`);
    app.unmount();
  });
});
