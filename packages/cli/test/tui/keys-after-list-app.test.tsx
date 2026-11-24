import { describe, expect, it, vi } from 'vitest';
import type { AutoClassifierView, SkillView } from '@momonga/protocol';
import { pollUntil } from '@momonga/testkit';
import { AGENTS_TITLE } from '../../src/tui/commands/agents.ts';
import { CONTEXT_IMPROVE_CONFIRM_TITLE } from '../../src/tui/commands/context.ts';
import { EFFORT_PICKER_TITLE } from '../../src/tui/commands/effort.ts';
import { HOOKS_TITLE } from '../../src/tui/commands/hooks.ts';
import { ADD_HTTP_ROW } from '../../src/tui/commands/mcp.ts';
import { PERMISSIONS_TITLE } from '../../src/tui/commands/permissions.ts';
import { RESUME_PICKER_TITLE } from '../../src/tui/commands/resume.ts';
import { CREATE_FROM_TEMPLATE_ROW, OPEN_IN_EDITOR_ROW, SKILLS_TITLE, TEMPLATE_NAME_TITLE } from '../../src/tui/commands/skills.ts';
import { STYLE_PICKER_TITLE } from '../../src/tui/commands/style.ts';
import { THEME_PICKER_TITLE } from '../../src/tui/commands/theme.ts';
import { SETTINGS_TITLE } from '../../src/tui/settings-screen.tsx';
import { HISTORY_SEARCH_TITLE } from '../../src/tui/app.tsx';
import { MEMORY_REVIEW_MODEL_TITLE, ROLE_TITLE } from '../../src/tui/models/texts.ts';
import { FRAME_BOUND_MS, KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { runView } from '../fake-backend.ts';
import { frame as eventFrame } from '../tui-harness.tsx';
import { account } from '../fake-plan-gateway.tsx';
import type { FakePlanOptions } from '../fake-plan-gateway.tsx';
import { PROBE, hold, inputLineOf, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming, Held, Shown } from './keys-shown-screen.tsx';
import { CONVERSATION, EFFORT_PICKER, MODEL_LIST, QWEN, SIGNED_IN, toRow } from './keys-shown-screen-cases.tsx';
import { freshPlace, writeSettings } from './settings-harness.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const GEMMA = 'lmstudio/gemma-3-4b';
const KITTY_ESCAPE = '\u001b[27u';
const PASTE_HELLO = `${KEYS.pasteStart}hello${KEYS.pasteEnd}`;
const CONFIRM_QUESTION = 'for the auto-mode classifier?';
const RESULT_SESSION = "The auto-mode classifier is now the session's model.";
const RESULT_OTHER = `The auto-mode classifier is now ${GEMMA}.`;
const SKILL: SkillView = { name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/p/.agents/skills/pdf/SKILL.md' };

const KEY_A = { classifier: QWEN, codeDigest: 'code', datasetDigest: 'dataset' };
const KEY_B = { classifier: GEMMA, codeDigest: 'code', datasetDigest: 'dataset' };
const VIEW_A: AutoClassifierView = { model: QWEN, key: KEY_A, measurement: 'not_measured' };
const VIEW_B: AutoClassifierView = { model: GEMMA, key: KEY_B, measurement: 'not_measured' };

const ALLOW = { optionId: 'o1', name: 'Allow once', kind: 'allow_once' };
const REJECT = { optionId: 'o3', name: 'Reject once', kind: 'reject_once' };
const APPROVAL = 'Permission requested: Write out.txt';
const FORM = { key: 'profile', mode: 'form', message: 'Tell me about you', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Your name' } }, required: ['name'] } };
const ELICITATION = 'MCP server calc asks for input';
const USAGE_LIMIT = runView({ status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never });
const LIMIT_LIST: Shown = (frame) => frame.includes('Manage usage') && frame.includes('Dismiss');

const autoModeSettings = () => ({
  models: {
    connections: [
      { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] },
      { adapter: 'chat-completions', provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', billing: 'local', maxConcurrency: 1, models: [{ id: 'gemma-3-4b', capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } }] },
    ],
  },
});

const autoModeGiven = (mode: 'auto' | 'manual' = 'auto') => {
  const place = freshPlace();
  writeSettings(place.userFile, autoModeSettings());
  return {
    options: {
      ...SIGNED_IN,
      models: [QWEN, GEMMA],
      billing: { [QWEN]: 'local' as const, [GEMMA]: 'local' as const },
      settingsPlace: { home: place.home, projectDir: place.project },
      session: { model: QWEN, permissionMode: mode, autoClassifier: VIEW_A },
      classifierViews: { [QWEN]: VIEW_A, [GEMMA]: VIEW_B },
    } satisfies FakePlanOptions,
    ready: `mode: ${mode}`,
  };
};

const reachAutoModeConfirm = async (driver: AtRealTiming, row: string): Promise<void> => {
  await driver.submit('/auto-mode');
  await driver.untilShown('Auto-mode classifier');
  await driver.settled();
  await toRow(driver, row);
  await driver.step(KEYS.enter, CONFIRM_QUESTION);
  await toRow(driver, 'Yes');
};

const withholdFrames = (driver: AtRealTiming) => {
  const original = driver.app.stdout.write;
  const pass = original as unknown as (chunk: string, cb?: () => void) => void;
  const held: [string, (() => void) | undefined][] = [];
  driver.app.stdout.write = ((chunk: string, cb?: () => void): void => {
    held.push([chunk, cb]);
  }) as typeof driver.app.stdout.write;
  return {
    untilRendered: (predicate: (frame: string) => boolean, description: string) =>
      pollUntil(
        async () => {
          await driver.pause(5);
          return held.some(([chunk]) => predicate(chunk));
        },
        { description, boundMs: FRAME_BOUND_MS },
      ),
    release: () => {
      driver.app.stdout.write = original;
      for (const [chunk, cb] of held.splice(0)) pass(chunk, cb);
    },
  };
};

describe('/auto-mode closes at Yes and accepts typed keys, digits, edits, and pastes right away', () => {
  for (const [label, targetRow, resultLine, noticePart] of [
    ["Use the session's model", "Use the session's model", RESULT_SESSION, 'has not been measured'],
    ['another model', GEMMA, RESULT_OTHER, `auto: classifier ${GEMMA}`],
  ] as const) {
    it(`${label}: keys typed in the same write as Yes appear in the input while save/session reread is held, then result and notice follow`, async () => {
      const driver = await startAtRealTiming(autoModeGiven('auto'));
      await reachAutoModeConfirm(driver, targetRow);
      const held = hold(driver.backend, 'session');
      driver.oneWrite(`${KEYS.enter}/frob`);
      await driver.pause(30);
      expect(shows(CONFIRM_QUESTION)(driver.frameNow())).toBe(false);
      expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> /frob');
      held.release();
      await driver.untilShown(resultLine);
      await driver.untilShown(noticePart);
      expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> /frob');
      expect(driver.backend.started).toEqual([]);
      driver.app.unmount();
    });
  }

  it("Use the session's model: choosing Yes with digit 2+Enter and immediately typing /frob puts /frob in the input", async () => {
    const driver = await startAtRealTiming(autoModeGiven('manual'));
    await driver.submit('/auto-mode');
    await driver.untilShown('Auto-mode classifier');
    await driver.settled();
    await toRow(driver, "Use the session's model");
    await driver.step(KEYS.enter, CONFIRM_QUESTION);
    driver.oneWrite(`2${KEYS.enter}/frob`);
    await driver.pause(100);
    expect(shows(CONFIRM_QUESTION)(driver.frameNow())).toBe(false);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> /frob');
    await driver.untilShown(RESULT_SESSION);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> /frob');
    driver.app.unmount();
  });

  it('/auto-mode: digits, Backspace, left arrow + insert, and bracketed paste right after Yes all apply to the prompt', async () => {
    const driver = await startAtRealTiming(autoModeGiven('manual'));
    await reachAutoModeConfirm(driver, GEMMA);
    driver.oneWrite(`${KEYS.enter}123${KEYS.backspace}${KEYS.left}x`);
    await driver.untilShown('> 1x2');
    driver.app.stdin.write(PASTE_HELLO);
    await driver.untilShown('> 1xhello2');
    await driver.untilShown(RESULT_OTHER);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> 1xhello2');
    driver.app.unmount();
  });

  it('/auto-mode: answering No closes immediately and accepts typed text; Esc on confirm returns to the classifier list', async () => {
    const driver = await startAtRealTiming(autoModeGiven('manual'));
    await reachAutoModeConfirm(driver, GEMMA);
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown('Auto-mode classifier');
    await driver.settled();
    await toRow(driver, GEMMA);
    await driver.step(KEYS.enter, CONFIRM_QUESTION);
    await toRow(driver, 'No');
    driver.oneWrite(`${KEYS.enter}abc`);
    await driver.untilShown('> abc');
    await driver.pause(100);
    expect(shows(CONFIRM_QUESTION)(driver.frameNow())).toBe(false);
    expect(driver.frameNow()).not.toContain(RESULT_OTHER);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> abc');
    driver.app.unmount();
  });

  it('Row 6 (/auto-mode): Esc while save/reread wait is held aborts without bringing the list back or cancelling a run', async () => {
    const driver = await startAtRealTiming(autoModeGiven('manual'));
    await reachAutoModeConfirm(driver, GEMMA);
    const held = hold(driver.backend, 'models');
    driver.oneWrite(`${KEYS.enter}${KITTY_ESCAPE}`);
    await driver.pause(100);
    held.release();
    await driver.pause(200);
    expect(shows(CONFIRM_QUESTION)(driver.frameNow())).toBe(false);
    expect(shows('Auto-mode classifier')(driver.frameNow())).toBe(false);
    expect(driver.backend.calls.filter((call) => call.startsWith('cancel:'))).toEqual([]);
    driver.app.unmount();
  });
});

type PromptTransitionCase = {
  readonly name: string;
  readonly given: () => { readonly options: FakePlanOptions; readonly extra?: Record<string, unknown>; readonly ready?: Shown };
  readonly reach: (driver: AtRealTiming) => Promise<void>;
  readonly trigger: string;
  readonly screenShown: Shown;
};

const placedSignedIn = () => {
  const place = freshPlace();
  return { options: { ...SIGNED_IN, settingsPlace: { home: place.home, projectDir: place.project } } satisfies FakePlanOptions };
};

const promptReturnCases: readonly PromptTransitionCase[] = [
  {
    name: '/mode enter choice',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/mode');
      await driver.untilShown('Permission mode');
      await driver.settled();
      await toRow(driver, 'acceptEdits');
    },
    trigger: KEYS.enter,
    screenShown: 'Permission mode',
  },
  {
    name: '/mode Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/mode');
      await driver.untilShown('Permission mode');
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: 'Permission mode',
  },
  {
    name: '/model switch enter choice',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/model');
      await driver.untilShown(MODEL_LIST);
      await driver.settled();
      await toRow(driver, 'gpt-6-luna');
      await driver.step(KEYS.enter, EFFORT_PICKER);
    },
    trigger: KEYS.enter,
    screenShown: EFFORT_PICKER,
  },
  {
    name: '/model Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/model');
      await driver.untilShown(MODEL_LIST);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: MODEL_LIST,
  },
  {
    name: '/effort Tab choice',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/effort');
      await driver.untilShown(EFFORT_PICKER_TITLE);
      await driver.settled();
      await toRow(driver, 'high');
    },
    trigger: KEYS.tab,
    screenShown: EFFORT_PICKER_TITLE,
  },
  {
    name: '/effort Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/effort');
      await driver.untilShown(EFFORT_PICKER_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: EFFORT_PICKER_TITLE,
  },
  {
    name: '/style Tab choice',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/style');
      await driver.untilShown(STYLE_PICKER_TITLE);
      await driver.settled();
      await toRow(driver, 'concise');
    },
    trigger: KEYS.tab,
    screenShown: STYLE_PICKER_TITLE,
  },
  {
    name: '/style Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/style');
      await driver.untilShown(STYLE_PICKER_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: STYLE_PICKER_TITLE,
  },
  {
    name: '/theme enter choice',
    given: () => ({
      options: SIGNED_IN,
      extra: {
        tuiSettings: {
          initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true },
          save: async () => undefined,
        },
      },
    }),
    reach: async (driver) => {
      await driver.submit('/theme');
      await driver.untilShown(THEME_PICKER_TITLE);
      await driver.settled();
      await toRow(driver, 'dark');
    },
    trigger: KEYS.enter,
    screenShown: THEME_PICKER_TITLE,
  },
  {
    name: '/theme Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/theme');
      await driver.untilShown(THEME_PICKER_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: THEME_PICKER_TITLE,
  },
  {
    name: '/login Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/login');
      await driver.untilShown('Add an API key');
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: 'Add an API key',
  },
  {
    name: '/logout confirm choice',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/logout');
      await driver.untilShown((frame) => frame.includes('Sign out') && /\d+\. /.test(frame));
      await driver.settled();
      await driver.step(KEYS.enter, 'again to sign out');
    },
    trigger: KEYS.enter,
    screenShown: 'again to sign out',
  },
  {
    name: '/logout Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/logout');
      await driver.untilShown((frame) => frame.includes('Sign out') && /\d+\. /.test(frame));
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: 'Sign out',
  },
  {
    name: '/skills Open in $EDITOR',
    given: () => ({ options: { ...SIGNED_IN, skills: [SKILL] }, extra: { externalEditor: { open: async () => ({ kind: 'opened' }), edit: async (text: string) => ({ kind: 'edited', text }) } } }),
    reach: async (driver) => {
      await driver.submit('/skills');
      await driver.untilShown(SKILLS_TITLE);
      await driver.settled();
      await toRow(driver, 'pdf');
      await driver.step(KEYS.enter, OPEN_IN_EDITOR_ROW);
    },
    trigger: KEYS.enter,
    screenShown: OPEN_IN_EDITOR_ROW,
  },
  {
    name: '/skills Esc close',
    given: () => ({ options: { ...SIGNED_IN, skills: [SKILL] } }),
    reach: async (driver) => {
      await driver.submit('/skills');
      await driver.untilShown(SKILLS_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: SKILLS_TITLE,
  },
  {
    name: '/agents Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/agents');
      await driver.untilShown(AGENTS_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: AGENTS_TITLE,
  },
  {
    name: '/context improve Cancel/Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/context improve');
      await driver.untilShown(CONTEXT_IMPROVE_CONFIRM_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: CONTEXT_IMPROVE_CONFIRM_TITLE,
  },
  {
    name: '/auto-mode top-list Esc close',
    given: () => autoModeGiven('manual'),
    reach: async (driver) => {
      await driver.submit('/auto-mode');
      await driver.untilShown('Auto-mode classifier');
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: 'Auto-mode classifier',
  },
  {
    name: '/config Esc close',
    given: placedSignedIn,
    reach: async (driver) => {
      await driver.submit('/config');
      await driver.untilShown(SETTINGS_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: SETTINGS_TITLE,
  },
  {
    name: '/permissions Esc close',
    given: placedSignedIn,
    reach: async (driver) => {
      await driver.submit('/permissions');
      await driver.untilShown(PERMISSIONS_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: PERMISSIONS_TITLE,
  },
  {
    name: '/hooks Esc close',
    given: placedSignedIn,
    reach: async (driver) => {
      await driver.submit('/hooks');
      await driver.untilShown(HOOKS_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: HOOKS_TITLE,
  },
  {
    name: '/mcp Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/mcp');
      await driver.untilShown(ADD_HTTP_ROW);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: ADD_HTTP_ROW,
  },
  {
    name: '/keybindings Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      await driver.submit('/keybindings');
      await driver.untilShown('Key bindings');
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: 'Key bindings',
  },
  {
    name: '/resume Esc close',
    given: () => ({ options: { ...SIGNED_IN, conversations: [CONVERSATION] } }),
    reach: async (driver) => {
      await driver.submit('/resume');
      await driver.untilShown(RESUME_PICKER_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: RESUME_PICKER_TITLE,
  },
  {
    name: 'ctrl+r history search enter choice',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      driver.app.stdin.write(KEYS.ctrlR);
      await driver.untilShown(HISTORY_SEARCH_TITLE);
      await driver.settled();
      await toRow(driver, 'an earlier prompt');
    },
    trigger: KEYS.enter,
    screenShown: HISTORY_SEARCH_TITLE,
  },
  {
    name: 'ctrl+r history search Esc close',
    given: () => ({ options: SIGNED_IN }),
    reach: async (driver) => {
      driver.app.stdin.write(KEYS.ctrlR);
      await driver.untilShown(HISTORY_SEARCH_TITLE);
      await driver.settled();
    },
    trigger: KEYS.escape,
    screenShown: HISTORY_SEARCH_TITLE,
  },
];

describe('all screens returning to prompt accept keys and pastes right after closing (including in the undrawn frame)', () => {
  for (const scenario of promptReturnCases) {
    it(`${scenario.name}: text + digits typed immediately after closing reach the prompt`, async () => {
      const driver = await startAtRealTiming(scenario.given());
      await scenario.reach(driver);
      const trigger = scenario.trigger === KEYS.escape ? KITTY_ESCAPE : scenario.trigger;
      driver.oneWrite(`${trigger}${PROBE}9`);
      await driver.untilShown((frame) => !shows(scenario.screenShown)(frame) && inputLineOf(frame).includes(`${PROBE}9`));
      expect(driver.backend.started).toEqual([]);
      driver.app.unmount();
    });
  }

  it('/skills createFile text prompt closes on submit and keeps following keys while createFromTemplate runs', async () => {
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const driver = await startAtRealTiming({
      options: SIGNED_IN,
      prepare: (backend) => {
        backend.createFromTemplate = async () => {
          calls += 1;
          await gate.promise;
          return { kind: 'created', file: '/tmp/skill.md' };
        };
      },
      extra: { externalEditor: { open: async () => ({ kind: 'opened' }), edit: async (text: string) => ({ kind: 'edited', text }) } },
    });
    await driver.submit('/skills');
    await driver.untilShown(SKILLS_TITLE);
    await driver.settled();
    await toRow(driver, CREATE_FROM_TEMPLATE_ROW);
    await driver.step(KEYS.enter, TEMPLATE_NAME_TITLE);
    driver.oneWrite(`my-skill${KEYS.enter}/frob`);
    await driver.pause(50);
    expect(calls).toBe(1);
    expect(shows(TEMPLATE_NAME_TITLE)(driver.frameNow())).toBe(false);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> /frob');
    gate.resolve();
    await driver.pause(100);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> /frob');
    driver.app.unmount();
  });

  it('/memory auto model closes list immediately on choice and keeps typed /frob in the prompt', async () => {
    const driver = await startAtRealTiming(autoModeGiven('manual'));
    await driver.submit('/memory auto model');
    await driver.untilShown(MEMORY_REVIEW_MODEL_TITLE);
    await driver.settled();
    await toRow(driver, GEMMA);
    driver.oneWrite(`${KEYS.enter}/frob`);
    await driver.pause(50);
    expect(shows(MEMORY_REVIEW_MODEL_TITLE)(driver.frameNow())).toBe(false);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> /frob');
    await driver.untilShown(GEMMA);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> /frob');
    driver.app.unmount();
  });

  it('usageLimit Dismiss closes panel and immediate keys reach the prompt', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('long task');
    await driver.until(() => driver.backend.started.length === 1, 'run started');
    await driver.settled();
    driver.backend.finish(USAGE_LIMIT);
    await driver.untilShown(LIMIT_LIST);
    await driver.settled();
    await toRow(driver, 'Dismiss');
    driver.oneWrite(`${KEYS.enter}${PROBE}9`);
    await driver.untilShown((frame) => !shows(LIMIT_LIST)(frame) && inputLineOf(frame).includes(`${PROBE}9`));
    expect(driver.backend.started).toHaveLength(1);
    driver.app.unmount();
  });

  it('toolView (ctrl+o) Esc close accepts immediate keys in the prompt', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('inspect tool');
    await driver.until(() => driver.backend.started.length === 1, 'run started');
    await driver.settled();
    driver.backend.emit(eventFrame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'Bash', kind: 'execute', title: 'Bash seq', rawInput: {} }));
    driver.backend.emit(eventFrame({ type: 'tool.completed', callId: 'c1', status: 'completed', output: Array.from({ length: 30 }, (_, index) => `out ${index}`).join('\n') }));
    await driver.untilShown('out 29');
    await driver.settled();
    driver.app.stdin.write(KEYS.ctrlO);
    await driver.untilShown((shown) => shown.startsWith('out 0'));
    await driver.settled();
    driver.oneWrite(`${KITTY_ESCAPE}${PROBE}9`);
    await driver.untilShown((frame) => inputLineOf(frame).includes(`${PROBE}9`));
    expect(driver.backend.started).toHaveLength(1);
    driver.app.unmount();
  });

  it('/login set active choice: undrawn prompt frame right after ports.closeScreen accepts text, digits, and paste', async () => {
    const driver = await startAtRealTiming({ options: { ...SIGNED_IN, accounts: [account(), account({ label: 'work', active: false })] } });
    await driver.submit('/login chatgpt');
    await driver.untilShown('Add another account or workspace');
    await driver.settled();
    await toRow(driver, 'work');
    const held = hold(driver.backend.plan, 'setActive');
    const frames = withholdFrames(driver);
    driver.app.stdin.write(KEYS.enter);
    await frames.untilRendered((chunk) => !chunk.includes('Add another account or workspace') && chunk.includes('mode: manual'), 'prompt rendered after /login closeScreen');
    driver.app.stdin.write(`m4${KEYS.backspace}n`);
    driver.app.stdin.write(PASTE_HELLO);
    held.release();
    frames.release();
    await driver.untilShown('> mnhello');
    expect(driver.backend.started).toEqual([]);
    driver.app.unmount();
  });

  it('undrawn prompt frame after /mode close: withheld render still accepts text, digits, Backspace, and bracketed paste', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('/mode');
    await driver.untilShown('Permission mode');
    await driver.settled();
    const frames = withholdFrames(driver);
    driver.app.stdin.write(KEYS.enter);
    await frames.untilRendered((chunk) => chunk.includes('mode: manual') && !chunk.includes('Permission mode'), 'prompt rendered while stdout withheld');
    driver.app.stdin.write(`a1${KEYS.backspace}b`);
    driver.app.stdin.write(PASTE_HELLO);
    frames.release();
    await driver.untilShown('> abhello');
    expect(driver.backend.started).toEqual([]);
    driver.app.unmount();
  });

  it('tool approval resolved → undrawn prompt frame accepts text, digits, Backspace, and paste', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('write a file');
    await driver.until(() => driver.backend.started.length === 1, 'run started');
    await driver.settled();
    driver.backend.emit(eventFrame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'Write out.txt', rawInput: { file_path: 'out.txt', content: 'x' } }));
    driver.backend.emit(eventFrame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'edits require approval', options: [ALLOW, REJECT], shown: { title: 'approval', input: {} } }));
    await driver.untilShown(APPROVAL);
    await driver.settled();
    const frames = withholdFrames(driver);
    driver.backend.emit(eventFrame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await frames.untilRendered((chunk) => !chunk.includes(APPROVAL) && chunk.includes('mode: manual'), 'prompt rendered after approval');
    driver.app.stdin.write(`z9${KEYS.backspace}k`);
    driver.app.stdin.write(PASTE_HELLO);
    frames.release();
    await driver.untilShown('> zkhello');
    expect(driver.backend.started).toHaveLength(1);
    driver.app.unmount();
  });

  it('MCP elicitation resolved → undrawn prompt frame accepts text, digits, Backspace, and paste', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('run calc');
    await driver.until(() => driver.backend.started.length === 1, 'run started');
    await driver.settled();
    driver.backend.emit(eventFrame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
    driver.backend.emit(eventFrame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'c1', server: 'calc', requests: [FORM] }));
    await driver.untilShown(ELICITATION);
    await driver.settled();
    const frames = withholdFrames(driver);
    driver.backend.emit(eventFrame({ type: 'tool.elicitation.resolved', inputId: 'in1', action: 'cancel' }));
    await frames.untilRendered((chunk) => !chunk.includes(ELICITATION) && chunk.includes('mode: manual'), 'prompt rendered after elicitation');
    driver.app.stdin.write(`p7${KEYS.backspace}q`);
    driver.app.stdin.write(PASTE_HELLO);
    frames.release();
    await driver.untilShown('> pqhello');
    expect(driver.backend.started).toHaveLength(1);
    driver.app.unmount();
  });
});

describe('案 A1 Row 5 & Row 7 contracts', () => {
  it('Row 5 (/auto-mode): Enter + abc + Enter in one write leaves abc in the input without submitting', async () => {
    const driver = await startAtRealTiming(autoModeGiven('manual'));
    await reachAutoModeConfirm(driver, GEMMA);
    driver.oneWrite(`${KEYS.enter}abc${KEYS.enter}`);
    await driver.pause(150);
    await driver.untilShown(RESULT_OTHER);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> abc');
    expect(driver.backend.started).toEqual([]);
    driver.app.unmount();
  });

  it('Row 5 (/mode & approval): Enter in the undrawn prompt frame leaves abc in the input without submitting, and Enter+Enter on empty prompt submits nothing', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('/mode');
    await driver.untilShown('Permission mode');
    await driver.settled();
    driver.oneWrite(`${KEYS.enter}abc${KEYS.enter}`);
    await driver.pause(100);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> abc');
    expect(driver.backend.started).toEqual([]);
    driver.app.unmount();

    const empty = await startAtRealTiming(SIGNED_IN);
    await empty.submit('/mode');
    await empty.untilShown('Permission mode');
    await empty.settled();
    empty.oneWrite(`${KEYS.enter}${KEYS.enter}`);
    await empty.pause(100);
    expect(inputLineOf(empty.frameNow()).trimEnd()).toBe('>');
    expect(empty.backend.started).toEqual([]);
    empty.app.unmount();

    const approved = await startAtRealTiming(SIGNED_IN);
    await approved.submit('write a file');
    await approved.until(() => approved.backend.started.length === 1, 'run started');
    await approved.settled();
    approved.backend.emit(eventFrame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'Write out.txt', rawInput: { file_path: 'out.txt', content: 'x' } }));
    approved.backend.emit(eventFrame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'edits require approval', options: [ALLOW, REJECT], shown: { title: 'approval', input: {} } }));
    await approved.untilShown(APPROVAL);
    await approved.settled();
    const frames = withholdFrames(approved);
    approved.backend.emit(eventFrame({ type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'o1' }));
    await frames.untilRendered((chunk) => !chunk.includes(APPROVAL) && chunk.includes('mode: manual'), 'prompt rendered after approval');
    approved.app.stdin.write(`abc${KEYS.enter}`);
    frames.release();
    await approved.untilShown('> abc');
    await approved.pause(50);
    expect(inputLineOf(approved.frameNow()).trimEnd()).toBe('> abc');
    expect(approved.backend.started).toHaveLength(1);
    approved.app.unmount();
  });

  it('Row 7 (Model settings -> Models for other roles sharing chooseRoleModel): keys, digits, and Enter typed during save wait do not leak to draft or ROLE_TITLE', async () => {
    const driver = await startAtRealTiming(autoModeGiven('manual'));
    await driver.submit('/model');
    await driver.untilShown(MODEL_LIST);
    await driver.settled();
    await toRow(driver, 'Model settings…');
    await driver.step(KEYS.enter, 'Models for other roles');
    await toRow(driver, 'Models for other roles');
    await driver.step(KEYS.enter, ROLE_TITLE);
    await toRow(driver, 'Auto-mode classifier');
    await driver.step(KEYS.enter, 'Auto-mode classifier');
    await toRow(driver, GEMMA);
    await driver.step(KEYS.enter, CONFIRM_QUESTION);
    await toRow(driver, 'Yes');
    const held: Held = hold(driver.backend, 'models');
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(20);
    await driver.burst([[PROBE, 0], ['1', 10], [KEYS.enter, 10]]);
    await driver.pause(50);
    held.release();
    await driver.untilShown(ROLE_TITLE);
    await driver.pause(150);
    expect(driver.frameNow()).not.toContain(PROBE);
    expect(driver.backend.started).toEqual([]);
    for (let step = 0; step < 5 && !driver.frameNow().includes('mode: manual'); step += 1) {
      driver.app.stdin.write(KEYS.escape);
      await driver.pause(150);
    }
    expect(driver.frameNow()).not.toContain(PROBE);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
    driver.app.unmount();
  });
});
