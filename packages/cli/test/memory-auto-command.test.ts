import { testKernelLock } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { createSlashRegistry } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import * as notices from '../src/tui/notices.ts';
import type { NoticeContext, NoticeSource } from '../src/tui/notices.ts';
import { bytesOf, documentOf, homeWith, threeModels } from './models-shell-harness.ts';
import { flowOf } from './tui-models-harness.ts';
import type { FlowFakes, FlowHarness, Step } from './tui-models-harness.ts';

const QWEN = 'ollama/qwen3.8:27b';

const ROWS = ['ollama/gemma-3-4b', QWEN, 'lmstudio/gemma-3-4b'];

const TITLE = 'Model for memory auto review';

const ON = 'memory auto review is on';

const OFF = 'memory auto review is off';

const NEEDS_MODEL = 'memory auto review needs a model';

const SESSION = 'ollama/gemma-3-4b:latest';

const SESSION_SHOWN = 'ollama/gemma-3-4b';

const UNCONFIGURED = 'openai/gpt-9';

const onWith = (model: string): string => `memory auto review is on, model ${model}`;

const memory = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find('memory');

const runIn = async (context: FlowHarness['context'], args: string): Promise<void> => {
  if (memory === undefined) throw new Error('the registry has no /memory');
  await memory.run(args, context as unknown as SlashContext);
};

const run = (harness: FlowHarness, args: string): Promise<void> => runIn(harness.context, args);

const withSettings = (context: TestContext, memorySettings: Record<string, unknown> | undefined, steps: readonly Step[] = [], fakes: FlowFakes = {}): FlowHarness =>
  flowOf(context, { ...threeModels(), ...(memorySettings === undefined ? {} : { memory: memorySettings }) }, steps, fakes);

const initialsOf = async (harness: FlowHarness, args: string): Promise<(number | undefined)[]> => {
  const initials: (number | undefined)[] = [];
  const { overlays } = harness.context;
  await runIn({ ...harness.context, overlays: { ...overlays, choose: (request) => (initials.push(request.initial), overlays.choose(request)) } }, args);
  return initials;
};

const memoryOf = (harness: FlowHarness): unknown => harness.written()['memory'];

describe('/memory auto on', () => {
  it('writes the model of the session and the switch without a selection when no review model is set, and names the model', async (context) => {
    const harness = withSettings(context, undefined, [], { model: SESSION });
    await run(harness, 'auto on');
    expect(harness.picks()).toEqual([]);
    expect(memoryOf(harness)).toEqual({ autoReviewModel: SESSION, autoReview: true });
    expect(harness.written()['autoMode']).toBeUndefined();
    expect(harness.infos).toEqual([onWith(SESSION_SHOWN)]);
  });

  it('prints the refusal sentence, writes nothing and leaves the switch off when the session model is not configured', async (context) => {
    const harness = withSettings(context, { autoReview: false }, [], { model: UNCONFIGURED });
    const before = harness.bytes();
    await run(harness, 'auto on');
    expect(harness.infos).toHaveLength(1);
    expect(harness.infos[0]).not.toMatch(/^memory auto review is on/);
    expect(harness.infos[0]).toContain(UNCONFIGURED);
    expect(harness.bytes()).toBe(before);
    expect(harness.picks()).toEqual([]);
  });

  it('turns the switch on when a review model is set, keeps that model instead of the session one, and names it', async (context) => {
    const harness = withSettings(context, { autoReviewModel: QWEN, forgetAfterDays: 30 }, [], { model: SESSION });
    await run(harness, 'auto on');
    expect(memoryOf(harness)).toEqual({ autoReviewModel: QWEN, forgetAfterDays: 30, autoReview: true });
    expect(harness.picks()).toEqual([]);
    expect(harness.infos).toEqual([onWith(QWEN)]);
  });

  it('names a stored review model that is not among the configured models as it is stored', async (context) => {
    const harness = withSettings(context, { autoReviewModel: UNCONFIGURED }, [], { model: SESSION });
    await run(harness, 'auto on');
    expect(memoryOf(harness)).toEqual({ autoReviewModel: UNCONFIGURED, autoReview: true });
    expect(harness.picks()).toEqual([]);
    expect(harness.infos).toEqual([onWith(UNCONFIGURED)]);
  });

  it('opens the model selection when no review model is set and the session has no model, and choosing a row writes the model and the switch and names the model', async (context) => {
    const harness = withSettings(context, undefined, [{ pick: 'ollama/gemma-3-4b' }]);
    await run(harness, 'auto on');
    expect(harness.picks()).toEqual([{ kind: 'pick', title: TITLE, lines: [], rows: ROWS }]);
    expect(memoryOf(harness)).toEqual({ autoReviewModel: SESSION, autoReview: true });
    expect(harness.written()['autoMode']).toBeUndefined();
    expect(harness.infos).toEqual([onWith(SESSION_SHOWN)]);
  });

  it('offers no row that means the session model', async (context) => {
    const harness = withSettings(context, undefined, [{ leave: true }]);
    await run(harness, 'auto on');
    expect(harness.picks()[0]?.title).toBe(TITLE);
    expect(harness.picks()[0]?.rows).not.toContain("Use the session's model");
    expect(harness.picks()[0]?.rows).toEqual(ROWS);
  });

  it('writes nothing and leaves memory auto review off when the selection is escaped while the session has no model', async (context) => {
    const harness = withSettings(context, { autoReview: false }, [{ leave: true }]);
    const before = harness.bytes();
    await run(harness, 'auto on');
    expect(harness.picks().map((pick) => pick.title)).toEqual([TITLE]);
    expect(harness.bytes()).toBe(before);
    expect(harness.infos).not.toContain(ON);
  });
});

describe('/memory auto model', () => {
  it('opens the same selection and writes only the model, leaving the switch off', async (context) => {
    const harness = withSettings(context, { autoReview: false }, [{ pick: 'lmstudio/gemma-3-4b' }]);
    await run(harness, 'auto model');
    expect(harness.picks()).toEqual([{ kind: 'pick', title: TITLE, lines: [], rows: ROWS }]);
    expect(memoryOf(harness)).toEqual({ autoReview: false, autoReviewModel: 'lmstudio/gemma-3-4b' });
    expect(harness.infos).toEqual(['The memory auto review model is now lmstudio/gemma-3-4b.']);
  });

  it.for([
    ['the second model is set', { autoReviewModel: QWEN }, 1],
    ['the third model is set', { autoReview: true, autoReviewModel: 'lmstudio/gemma-3-4b' }, 2],
    ['no model is set', { autoReview: true }, 0],
    ['nothing is set', undefined, 0],
    ['the set model is not configured', { autoReviewModel: UNCONFIGURED }, 0],
    ['the second model is set by its bare name', { autoReviewModel: 'qwen3.8:27b' }, 1],
  ] as const)('opens the selection on the row of the current model when %s', async ([, settings, initial], context) => {
    const harness = withSettings(context, settings, [{ leave: true }], { model: SESSION });
    expect(await initialsOf(harness, 'auto model')).toEqual([initial]);
    expect(harness.picks().map((pick) => pick.title)).toEqual([TITLE]);
  });

  it('opens the selection also when a model is set, and replaces it, leaving the switch on', async (context) => {
    const harness = withSettings(context, { autoReview: true, autoReviewModel: QWEN }, [{ pick: 'ollama/gemma-3-4b' }]);
    await run(harness, 'auto model');
    expect(harness.picks().map((pick) => pick.title)).toEqual([TITLE]);
    expect(memoryOf(harness)).toEqual({ autoReview: true, autoReviewModel: 'ollama/gemma-3-4b:latest' });
  });

  it('writes nothing when the selection is escaped', async (context) => {
    const harness = withSettings(context, { autoReview: true, autoReviewModel: QWEN }, [{ leave: true }]);
    const before = harness.bytes();
    await run(harness, 'auto model');
    expect(harness.picks().map((pick) => pick.title)).toEqual([TITLE]);
    expect(harness.bytes()).toBe(before);
  });
});

describe('/memory auto off and /memory auto', () => {
  it('turns the switch off, keeps the model, and says so', async (context) => {
    const harness = withSettings(context, { autoReview: true, autoReviewModel: QWEN });
    await run(harness, 'auto off');
    expect(memoryOf(harness)).toEqual({ autoReview: false, autoReviewModel: QWEN });
    expect(harness.infos).toEqual([OFF]);
  });

  it.for([
    ['on', { autoReview: true, autoReviewModel: QWEN }, onWith(QWEN)],
    ['on with a model shown by its display', { autoReview: true, autoReviewModel: SESSION }, onWith(SESSION_SHOWN)],
    ['on with a model that is not configured', { autoReview: true, autoReviewModel: UNCONFIGURED }, onWith(UNCONFIGURED)],
    ['on with no model set', { autoReview: true }, ON],
    ['off', { autoReview: false, autoReviewModel: QWEN }, OFF],
    ['off by default', undefined, OFF],
  ] as const)('prints the current state when it is %s and writes nothing', async ([, settings, line], context) => {
    const harness = withSettings(context, settings, [], { model: SESSION });
    const before = harness.bytes();
    await run(harness, 'auto');
    expect(harness.infos).toEqual([line]);
    expect(harness.bytes()).toBe(before);
    expect(harness.picks()).toEqual([]);
  });

  it.for(['auto maybe', 'auto on now', 'auto model ollama/qwen3.8:27b', 'auto off please'])('prints the usage of /memory for /memory %s and writes nothing', async (args, context) => {
    const harness = withSettings(context, { autoReview: false });
    const before = harness.bytes();
    await run(harness, args);
    const usage = flowOf(context, threeModels(), []);
    await run(usage, 'forget mem-1');
    expect(harness.infos).toEqual(usage.infos);
    expect(harness.infos[0]).toMatch(/^usage: \/memory /);
    expect(harness.bytes()).toBe(before);
    expect(harness.picks()).toEqual([]);
  });

  it('lists the subcommand auto in the help of /memory', () => {
    expect(memory?.subcommands).toContainEqual({ name: 'auto', usage: '[on|off|model]', description: 'turn memory auto review on or off, or choose its model' });
  });
});

describe('the startup line of memory auto review', () => {
  const sourceOf = (home: string): NoticeSource => {
    const make = (notices as Record<string, unknown>)['memoryAutoReviewNoticeSource'];
    if (typeof make !== 'function') throw new Error('../src/tui/notices.ts does not export memoryAutoReviewNoticeSource');
    return (make as (ports: { env: NodeJS.ProcessEnv; home: string; interrupt: AbortSignal }, lock: () => ReturnType<typeof testKernelLock>) => NoticeSource)({ env: process.env, home, interrupt: new AbortController().signal }, () => testKernelLock());
  };

  const inSession = (model: string): NoticeContext => ({ session: { model } }) as unknown as NoticeContext;

  const memoryIn = (settingsFile: string): unknown => documentOf(settingsFile)['memory'];

  it('writes the model of the session and names it when the switch is on and no model is set', async (context) => {
    const { home, settingsFile } = homeWith(context, { ...threeModels(), memory: { autoReview: true } });
    expect(await sourceOf(home)(inSession(SESSION))).toEqual([onWith(SESSION_SHOWN)]);
    expect(memoryIn(settingsFile)).toEqual({ autoReview: true, autoReviewModel: SESSION });
  });

  it('writes nothing and says nothing when the switch is on, no model is set and the session has no model', async (context) => {
    const { home, settingsFile } = homeWith(context, { ...threeModels(), memory: { autoReview: true } });
    const before = bytesOf(settingsFile);
    expect(await sourceOf(home)(inSession(''))).toEqual([]);
    expect(bytesOf(settingsFile)).toBe(before);
  });

  it.for([
    ['the switch is off', { autoReview: false }],
    ['the switch is off with a model', { autoReview: false, autoReviewModel: QWEN }],
    ['nothing is set', undefined],
    ['the switch is on with a configured model', { autoReview: true, autoReviewModel: QWEN }],
  ] as const)('says nothing and writes nothing when %s', async ([, settings], context) => {
    const { home, settingsFile } = homeWith(context, { ...threeModels(), ...(settings === undefined ? {} : { memory: settings }) });
    const before = bytesOf(settingsFile);
    expect(await sourceOf(home)(inSession(SESSION))).toEqual([]);
    expect(bytesOf(settingsFile)).toBe(before);
  });

  it('writes nothing and prints only the refusal sentence of /memory auto on when the session model is not configured', async (context) => {
    const slash = withSettings(context, { autoReview: true }, [], { model: UNCONFIGURED });
    await run(slash, 'auto on');
    expect(slash.infos).toHaveLength(1);
    const { home, settingsFile } = homeWith(context, { ...threeModels(), memory: { autoReview: true } });
    const before = bytesOf(settingsFile);
    expect(await sourceOf(home)(inSession(UNCONFIGURED))).toEqual(slash.infos);
    expect(bytesOf(settingsFile)).toBe(before);
  });

  it('no longer has the line that asked for a model', () => {
    expect((notices as Record<string, unknown>)['MEMORY_AUTO_REVIEW_NEEDS_MODEL']).toBeUndefined();
  });

  it('is one of the default startup notice sources', async (context) => {
    const { home } = homeWith(context, { ...threeModels(), memory: { autoReview: true } });
    const ports = { env: process.env, home, interrupt: new AbortController().signal };
    const update = { state: { read: async () => undefined } } as unknown as Parameters<typeof notices.defaultNoticeSources>[1];
    const sources = notices.defaultNoticeSources(ports, update, () => testKernelLock());
    const lines: string[] = [];
    for (const source of sources) {
      const printed = await source(inSession(SESSION)).catch(() => [] as readonly string[]);
      lines.push(...printed);
    }
    expect(lines).toContain(onWith(SESSION_SHOWN));
    expect(lines.filter((line) => line.startsWith(NEEDS_MODEL))).toEqual([]);
  });
});
