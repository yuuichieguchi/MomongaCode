import type { PlanModelsResponse, ReasoningCapability, SkillView } from '@momonga/protocol';
import { HOOKS_TITLE, HOOK_EVENT_TITLE, HOOK_MATCHER_TITLE } from '../../src/tui/commands/hooks.ts';
import { ADD_HTTP_ROW, ADD_STDIO_ROW, MCP_COMMAND_TITLE, MCP_NAME_TITLE } from '../../src/tui/commands/mcp.ts';
import { PERMISSIONS_TITLE } from '../../src/tui/commands/permissions.ts';
import { RESUME_PICKER_TITLE } from '../../src/tui/commands/resume.ts';
import { AGENTS_TITLE } from '../../src/tui/commands/agents.ts';
import { CREATE_FROM_TEMPLATE_ROW, OPEN_IN_EDITOR_ROW, SKILLS_TITLE, TEMPLATE_NAME_TITLE } from '../../src/tui/commands/skills.ts';
import { HISTORY_SEARCH_TITLE } from '../../src/tui/app.tsx';
import { OPEN_FILE_TITLE, OPEN_SETTINGS_FILE_ROW, SAVING_SETTING, SETTINGS_TITLE } from '../../src/tui/settings-screen.tsx';
import { CHECKING_PHASE, SEARCHING_PHASE } from '../../src/tui/models/texts.ts';
import { RESET_ALL_QUESTION } from '../../src/tui/commands/keybindings.ts';
import { createKeyBindings } from '../../src/tui/keys/store.ts';
import type { KeyFiles } from '../../src/tui/keys/store.ts';
import type { FakeConversation } from '../fake-backend.ts';
import { account } from '../fake-plan-gateway.tsx';
import type { FakePlanOptions } from '../fake-plan-gateway.tsx';
import { KEYS } from '../ink-helpers.ts';
import { highlighted, hold, shows } from './keys-shown-screen.tsx';
import type { AtRealTiming, Held, Shown, StartGiven } from './keys-shown-screen.tsx';
import { freshPlace, writeSettings } from './settings-harness.tsx';

export const QWEN = 'ollama/qwen3.8:27b';
export const LUNA = 'chatgpt/gpt-6-luna';
const REASONING: ReasoningCapability = { control: 'reasoning_effort', lowest: 'low' };
const usable = (slug: string): PlanModelsResponse['models'][number] => ({ slug, displayName: slug.toUpperCase(), usable: true, contextWindow: 272000, maxOutputTokens: 128000 });

export const SIGNED_IN: FakePlanOptions = {
  session: { model: QWEN },
  models: [QWEN, LUNA],
  billing: { [QWEN]: 'local', [LUNA]: 'plan' },
  reasoning: { [QWEN]: REASONING, [LUNA]: REASONING },
  accounts: [account()],
  catalogs: { chatgpt: { readAt: '2026-11-10T00:00:00.000Z', models: [usable('gpt-6.2-sol')] } },
  dismissed: { 'invite:chatgpt': 'x' },
  history: ['an earlier prompt'],
};

export const NO_ACCOUNT: FakePlanOptions = { ...SIGNED_IN, accounts: [], catalogs: {} };

const SKILL: SkillView = { name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/p/.agents/skills/pdf/SKILL.md' };

const NOW = 10_000_000_000;
const ended = { type: 'run.status', from: 'RUNNING', to: 'COMPLETED' };
export const CONVERSATION: FakeConversation = {
  session: { id: 'bbbbbbbb22222222', createdAt: NOW - 72 * 3_600_000 },
  firstPrompt: 'add tests',
  runs: [
    {
      id: 'tests-1',
      frames: [
        { type: 'user.message', text: 'add tests' },
        { type: 'agent.message.delta', attempt: 0, itemId: 'm1', text: 'Three tests added.' },
        ended,
      ].map((event, index) => ({ id: index + 1, event: String(event['type']), data: { runId: 'tests-1', sessionId: 's', step: 1, createdAt: 1000, id: index + 1, seq: index + 1, ...event } })) as never,
    },
  ],
};

export const keyFilesHeld = () => {
  let content: string | undefined;
  let mtimeMs = 1;
  const written: string[] = [];
  const files: KeyFiles = {
    stat: async () => (content === undefined ? undefined : { mtimeMs, size: Buffer.byteLength(content) }),
    read: async () => content ?? '',
    write: async (_target, body) => {
      written.push(body);
      content = body;
      mtimeMs += 1;
    },
  };
  return { files, written };
};

const withKeyBindings = async (): Promise<StartGiven> => {
  const keyBindings = createKeyBindings({ file: '/home/u/.momonga/keybindings.json', shownFile: '~/.momonga/keybindings.json', files: keyFilesHeld().files });
  await keyBindings.load();
  return { options: SIGNED_IN, extra: { keyBindings } };
};

const settingsGiven = (seed: (place: ReturnType<typeof freshPlace>) => void = () => undefined): StartGiven => {
  const place = freshPlace();
  seed(place);
  return { options: { ...SIGNED_IN, settingsPlace: { home: place.home, projectDir: place.project } } };
};

export const rowOf = (frame: string, label: string): number => {
  const line = frame.split('\n').find((row) => /\d+\. /.test(row) && row.includes(label));
  if (line === undefined) throw new Error(`no row ${label} in:\n${frame}`);
  return Number(/(\d+)\. /.exec(line)?.[1]);
};

export const toRow = async (driver: AtRealTiming, label: string): Promise<void> => {
  const at = rowOf(await driver.untilShown((frame) => /\d+\. /.test(frame) && frame.includes(label)), label);
  const line = driver.frameNow().split('\n').find((row) => row.includes('›') && /\d+\. /.test(row));
  const from = line === undefined ? 1 : Number(/(\d+)\. /.exec(line)?.[1] ?? 1);
  driver.app.stdin.write(at >= from ? KEYS.down.repeat(at - from) : KEYS.up.repeat(from - at));
  await driver.untilShown(highlighted(label));
  await driver.settled();
};

const filterTo = async (driver: AtRealTiming, label: string): Promise<void> => {
  await driver.step(label, `filter: ${label}`);
  await driver.untilShown(highlighted(label));
  await driver.settled();
};

const opened = async (driver: AtRealTiming, line: string, shown: Shown): Promise<void> => {
  await driver.submit(line);
  await driver.untilShown(shown);
  await driver.settled();
};

export const MODEL_LIST: Shown = 'Model settings…';
export const EFFORT_PICKER = (frame: string): boolean => frame.includes('Reasoning effort') && frame.includes('1. low');
export const CONNECT: Shown = 'Add an API key';
export const API_LIST = (frame: string): boolean => frame.includes('OpenAI-compatible API') && !frame.includes('Address:');
export const ADDRESS: Shown = 'Address:';
const PICKER = 'Add another account or workspace';
const HUB = (frame: string): boolean => frame.includes('Servers') && frame.includes('Add a model');

const openHub = async (driver: AtRealTiming): Promise<void> => {
  await opened(driver, '/model', MODEL_LIST);
  await toRow(driver, 'Model settings…');
  await driver.step(KEYS.enter, HUB);
};

const ADD_WAYS = (frame: string): boolean => frame.includes('Search this computer for model servers') && !frame.includes('Servers');

let detection = Promise.withResolvers<void>();

const openAdd = async (driver: AtRealTiming): Promise<void> => {
  await openHub(driver);
  await toRow(driver, 'Add a model');
  await driver.step(KEYS.enter, ADD_WAYS);
};

const mcpGiven = (): StartGiven => {
  const given = settingsGiven((place) => writeSettings(place.userFile, { mcpServers: { files: { command: 'npx' } } }));
  return { ...given, options: { ...given.options, mcpServers: [{ name: 'files', scope: 'user', transport: 'stdio', auth: 'not_required' }, { name: 'tracker', scope: 'project', transport: 'http', url: 'https://tracker.example/mcp', auth: 'required', approval: { digest: 'a'.repeat(64), changed: false } }] } };
};
const SETTINGS = (frame: string): boolean => frame.includes(SETTINGS_TITLE) && frame.includes('filter:');

export type Transition = {
  readonly flow: string;
  readonly step: string;
  readonly given: () => FakePlanOptions | StartGiven | Promise<StartGiven>;
  readonly reach: (driver: AtRealTiming) => Promise<void>;
  readonly go?: string;
  readonly previous: Shown;
  readonly between?: readonly Shown[];
  readonly next: Shown;
  readonly row: string;
  readonly holdOn?: (driver: AtRealTiming) => Held;
  readonly read?: boolean;
  readonly waitScreen?: readonly [string, string];
  readonly field?: boolean;
};

const notPrevious = (previous: Shown, next: Shown) => (frame: string): boolean => shows(next)(frame) && !shows(previous)(frame);

export const transitions: readonly Transition[] = [
  {
    flow: '/model',
    step: 'a configured model row → Reasoning effort, the listing read later',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await opened(driver, '/model', MODEL_LIST);
      await toRow(driver, 'gpt-6-luna');
    },
    previous: MODEL_LIST,
    between: ['Loading models…'],
    next: EFFORT_PICKER,
    row: 'gpt-6-luna',
    holdOn: (driver) => hold(driver.backend, 'models'),
    read: true,
  },
  {
    flow: 'models hub',
    step: 'Model settings… → the models hub, its listing read later',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await opened(driver, '/model', MODEL_LIST);
      await toRow(driver, 'Model settings…');
    },
    previous: MODEL_LIST,
    next: (frame) => HUB(frame) && !frame.includes('Model settings…'),
    row: 'Model settings…',
    holdOn: (driver) => hold(driver.backend, 'health'),
    read: true,
    waitScreen: ['Models', CHECKING_PHASE],
  },
  {
    flow: 'models hub',
    step: 'Add a model → its list of ways',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await openHub(driver);
      await toRow(driver, 'Add a model');
    },
    previous: HUB,
    next: ADD_WAYS,
    row: 'Add a model',
  },
  {
    flow: 'models add',
    step: 'Search this computer → what the search found, the search read later',
    given: () => {
      detection = Promise.withResolvers<void>();
      const gate = detection;
      return { options: { ...SIGNED_IN, detect: async () => {
        await gate.promise;
        return [];
      } } };
    },
    reach: async (driver) => {
      await openAdd(driver);
      await toRow(driver, 'Search this computer for model servers');
    },
    previous: ADD_WAYS,
    next: 'No model server answered on this computer.',
    row: 'Search this computer for model servers',
    holdOn: () => {
      const gate = detection;
      return { release: () => gate.resolve(), calls: () => 0 };
    },
    read: true,
    waitScreen: ['Add a model', SEARCHING_PHASE],
  },
  {
    flow: 'models add',
    step: 'Type the address of a model server → the address field',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await openAdd(driver);
      await toRow(driver, 'Type the address of a model server');
    },
    previous: ADD_WAYS,
    next: 'Address (for example http://127.0.0.1:11434):',
    row: 'Type the address of a model server',
    field: true,
  },
  {
    flow: 'models add',
    step: 'Use a service with an API key → the list of APIs',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await openAdd(driver);
      await toRow(driver, 'Use a service with an API key');
    },
    previous: ADD_WAYS,
    next: API_LIST,
    row: 'Use a service with an API key',
  },
  {
    flow: 'models add',
    step: 'Run a program as a model server → the program field',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await openAdd(driver);
      await toRow(driver, 'Run a program as a model server');
    },
    previous: ADD_WAYS,
    next: 'Write the full path of the program.',
    row: 'Run a program as a model server',
    field: true,
  },
  {
    flow: 'models fields',
    step: 'a model of the hub → its fields',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await openHub(driver);
      await toRow(driver, 'ollama/qwen3.8:27b');
    },
    previous: HUB,
    next: (frame) => frame.includes('1. Edit') && frame.includes('2. Remove') && !HUB(frame),
    row: 'ollama/qwen3.8:27b',
  },
  {
    flow: '/login',
    step: 'ChatGPT → The sandbox is off, the sandbox read later',
    given: () => NO_ACCOUNT,
    reach: async (driver) => {
      Object.assign(driver.backend, { sandbox: async () => 'none' as const });
      await opened(driver, '/login', CONNECT);
      await toRow(driver, 'ChatGPT');
    },
    previous: CONNECT,
    next: 'The sandbox is off',
    row: 'ChatGPT',
    holdOn: (driver) => hold(driver.backend, 'sandbox'),
    read: true,
  },
  {
    flow: '/login',
    step: 'Add an API key → the list of APIs',
    given: () => NO_ACCOUNT,
    reach: async (driver) => {
      await opened(driver, '/login', CONNECT);
      await toRow(driver, 'Add an API key');
    },
    previous: CONNECT,
    next: API_LIST,
    row: 'Add an API key',
  },
  {
    flow: '/login',
    step: 'OpenAI-compatible API → Address field',
    given: () => NO_ACCOUNT,
    reach: async (driver) => {
      await opened(driver, '/login', CONNECT);
      await toRow(driver, 'Add an API key');
      await driver.step(KEYS.enter, API_LIST);
      await toRow(driver, 'OpenAI-compatible API');
    },
    previous: API_LIST,
    next: ADDRESS,
    row: 'OpenAI-compatible API',
    field: true,
  },
  {
    flow: '/login provider flow',
    step: 'the ChatGPT subscription row → the account list, the accounts read later',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await opened(driver, '/login', CONNECT);
      await toRow(driver, 'OpenAI (ChatGPT subscription)');
    },
    previous: CONNECT,
    next: PICKER,
    row: 'OpenAI (ChatGPT subscription)',
    holdOn: (driver) => hold(driver.backend.plan, 'accounts'),
    read: true,
  },
  {
    flow: '/login provider flow',
    step: 'Rename account → its text field',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await opened(driver, '/login chatgpt', PICKER);
      await toRow(driver, 'Rename account chatgpt');
    },
    previous: PICKER,
    next: notPrevious(PICKER, 'Rename account chatgpt'),
    row: 'Rename account chatgpt',
    field: true,
  },
  {
    flow: '/login provider flow',
    step: 'Remove account → its confirmation list',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await opened(driver, '/login chatgpt', PICKER);
      await toRow(driver, 'Remove account chatgpt');
    },
    previous: PICKER,
    next: notPrevious(PICKER, 'Remove account chatgpt'),
    row: 'Remove account chatgpt',
  },
  {
    flow: '/login provider flow',
    step: 'Add another account → the label field',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await opened(driver, '/login chatgpt', PICKER);
      await toRow(driver, PICKER);
    },
    previous: PICKER,
    next: notPrevious(PICKER, 'chatgpt-2'),
    row: PICKER,
    field: true,
  },
  {
    flow: 'sign-in',
    step: 'the welcome row → the sign-in waiting screen, the sandbox read later',
    given: () => ({ options: { models: [], accounts: [], callbackArrives: false }, ready: 'Continue with ChatGPT' }),
    reach: async (driver) => {
      await toRow(driver, 'Continue with ChatGPT');
    },
    previous: 'Continue with ChatGPT',
    next: 'On a remote machine? Paste the redirect URL here',
    row: 'Continue with ChatGPT',
    holdOn: (driver) => hold(driver.backend, 'sandbox'),
    read: true,
  },
  {
    flow: '/config',
    step: 'a choice setting (Sandbox) → its choices',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Sandbox');
    },
    previous: SETTINGS,
    next: (frame) => frame.includes('1. seatbelt') && frame.includes('3. none'),
    row: 'Sandbox',
  },
  {
    flow: '/config',
    step: 'the none choice → the question before the sandbox is turned off',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Sandbox');
      await driver.step(KEYS.enter, '3. none');
      await toRow(driver, 'none');
    },
    previous: (frame) => frame.includes('1. seatbelt') && frame.includes('3. none'),
    next: 'Run commands without a sandbox?',
    row: 'none',
  },
  {
    flow: '/config',
    step: 'a text setting (Forget after (days)) → its text field',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Forget after (days)');
    },
    previous: SETTINGS,
    next: 'a whole number from 1',
    row: 'Forget after (days)',
    field: true,
  },
  {
    flow: '/config',
    step: 'the open-file row → the list of files',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, OPEN_SETTINGS_FILE_ROW);
    },
    previous: SETTINGS,
    next: OPEN_FILE_TITLE,
    row: OPEN_SETTINGS_FILE_ROW,
  },
  {
    flow: '/config',
    step: 'a toggle (Automatic compaction) written → the settings list read again later',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Automatic compaction');
    },
    previous: SETTINGS,
    next: (frame) => SETTINGS(frame) && /Automatic compaction\s+off\s+user/.test(frame),
    row: 'Automatic compaction',
    holdOn: (driver) => hold(driver.backend, 'editSettings'),
    waitScreen: [SETTINGS_TITLE, SAVING_SETTING],
  },
  {
    flow: '/config collection',
    step: 'Verification commands → its collection list',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Verification commands');
    },
    previous: SETTINGS,
    next: 'Verification commands (user)',
    row: 'Verification commands',
  },
  {
    flow: '/config collection',
    step: 'Add → its text field',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Verification commands');
      await driver.step(KEYS.enter, 'Verification commands (user)');
      await toRow(driver, 'Add');
    },
    previous: 'Verification commands (user)',
    next: 'enter to confirm',
    row: 'Add',
    field: true,
  },
  {
    flow: '/config collection',
    step: 'Add of a form (Prices) → its first field',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Prices');
      await driver.step(KEYS.enter, 'Prices (user)');
      await toRow(driver, 'Add');
    },
    previous: 'Prices (user)',
    next: 'Prices: Provider',
    row: 'Add',
    field: true,
  },
  {
    flow: '/config collection',
    step: 'an entry → its action list',
    given: () => settingsGiven((place) => writeSettings(place.userFile, { verification: { commands: ['npm run lint'] } })),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Verification commands');
      await driver.step(KEYS.enter, 'Verification commands (user)');
      await toRow(driver, 'npm run lint');
    },
    previous: 'Verification commands (user)',
    next: '1. Move up',
    row: 'npm run lint',
  },
  {
    flow: '/config collection',
    step: 'delete on an entry → the remove question',
    given: () => settingsGiven((place) => writeSettings(place.userFile, { verification: { commands: ['npm run lint'] } })),
    reach: async (driver) => {
      await opened(driver, '/config', SETTINGS);
      await filterTo(driver, 'Verification commands');
      await driver.step(KEYS.enter, 'Verification commands (user)');
      await toRow(driver, 'npm run lint');
    },
    go: KEYS.delete,
    previous: 'Verification commands (user)',
    next: 'Remove npm run lint?',
    row: 'npm run lint',
  },
  {
    flow: '/permissions',
    step: 'Allow rules → its rule list',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/permissions', PERMISSIONS_TITLE);
      await toRow(driver, 'Allow rules');
    },
    previous: PERMISSIONS_TITLE,
    next: (frame) => !frame.includes(PERMISSIONS_TITLE) && frame.includes('1. Add'),
    row: 'Allow rules',
  },
  {
    flow: '/permissions',
    step: 'Add → the rule text field',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/permissions', PERMISSIONS_TITLE);
      await toRow(driver, 'Allow rules');
      await driver.step(KEYS.enter, '1. Add');
      await toRow(driver, 'Add');
    },
    previous: '1. Add',
    next: 'Allowed: Bash(npm test:*)',
    row: 'Add',
    field: true,
  },
  {
    flow: '/permissions',
    step: 'delete on a rule → the remove question',
    given: () => settingsGiven((place) => writeSettings(place.userFile, { permissions: { allow: ['Bash(npm run lint)'] } })),
    reach: async (driver) => {
      await opened(driver, '/permissions', PERMISSIONS_TITLE);
      await toRow(driver, 'Allow rules');
      await driver.step(KEYS.enter, 'Bash(npm run lint)');
      await toRow(driver, 'Bash(npm run lint)');
    },
    go: KEYS.delete,
    previous: '2. Add',
    next: 'Remove Bash(npm run lint)',
    row: 'Bash(npm run lint)',
  },
  {
    flow: '/hooks',
    step: 'Add → the event list',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/hooks', HOOKS_TITLE);
      await toRow(driver, 'Add');
    },
    previous: HOOKS_TITLE,
    next: HOOK_EVENT_TITLE,
    row: 'Add',
  },
  {
    flow: '/hooks',
    step: 'an event → the matcher field',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/hooks', HOOKS_TITLE);
      await toRow(driver, 'Add');
      await driver.step(KEYS.enter, HOOK_EVENT_TITLE);
      await toRow(driver, 'PreToolUse');
    },
    previous: HOOK_EVENT_TITLE,
    next: HOOK_MATCHER_TITLE,
    row: 'PreToolUse',
    field: true,
  },
  {
    flow: '/hooks',
    step: 'delete on a hook → the remove question',
    given: () => settingsGiven((place) => writeSettings(place.userFile, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done', timeout: 5 }] }] } })),
    reach: async (driver) => {
      await opened(driver, '/hooks', HOOKS_TITLE);
      await toRow(driver, 'say done');
    },
    go: KEYS.delete,
    previous: HOOKS_TITLE,
    next: (frame) => frame.includes('Remove') && frame.includes('› 1. No'),
    row: 'say done',
  },
  {
    flow: '/mcp',
    step: 'Add a stdio server → the name field',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/mcp', ADD_HTTP_ROW);
      await toRow(driver, ADD_STDIO_ROW);
    },
    previous: ADD_HTTP_ROW,
    next: MCP_NAME_TITLE,
    row: ADD_STDIO_ROW,
    field: true,
  },
  {
    flow: '/mcp',
    step: 'the name field → the command field',
    given: () => settingsGiven(),
    reach: async (driver) => {
      await opened(driver, '/mcp', ADD_HTTP_ROW);
      await toRow(driver, ADD_STDIO_ROW);
      await driver.step(KEYS.enter, MCP_NAME_TITLE);
      await driver.step('files', '> files');
    },
    previous: MCP_NAME_TITLE,
    next: MCP_COMMAND_TITLE,
    row: '',
  },
  {
    flow: '/mcp',
    step: 'a server of the user file → the remove question',
    given: () => mcpGiven(),
    reach: async (driver) => {
      await opened(driver, '/mcp', ADD_HTTP_ROW);
      await toRow(driver, 'files');
    },
    previous: ADD_HTTP_ROW,
    next: 'Remove files?',
    row: 'files',
  },
  {
    flow: '/mcp',
    step: 'a server of the project → its enable/disable list',
    given: () => mcpGiven(),
    reach: async (driver) => {
      await opened(driver, '/mcp', ADD_HTTP_ROW);
      await toRow(driver, 'tracker');
    },
    previous: ADD_HTTP_ROW,
    next: '2. Disable',
    row: 'tracker',
  },
  {
    flow: '/keybindings',
    step: 'an action row → the key capture',
    given: withKeyBindings,
    reach: async (driver) => {
      await opened(driver, '/keybindings', 'Key bindings');
      await driver.step('history.search', 'filter: history.search');
      await driver.untilShown(highlighted('history.search'));
    },
    previous: 'Key bindings',
    next: 'Press the new key for history.search',
    row: 'history.search',
  },
  {
    flow: '/keybindings',
    step: 'Reset all to the defaults → its question',
    given: withKeyBindings,
    reach: async (driver) => {
      await opened(driver, '/keybindings', 'Key bindings');
      await toRow(driver, 'Reset all to the defaults');
    },
    previous: 'type to filter',
    next: RESET_ALL_QUESTION,
    row: 'Reset all to the defaults',
  },
  {
    flow: '/keybindings',
    step: 'a key another action uses, captured → the Replace question',
    given: withKeyBindings,
    reach: async (driver) => {
      await opened(driver, '/keybindings', 'Key bindings');
      await driver.step('editor.lineEnd', 'filter: editor.lineEnd');
      await driver.untilShown(highlighted('editor.lineEnd'));
      await driver.step(KEYS.enter, 'Press the new key for editor.lineEnd');
    },
    go: KEYS.ctrlA,
    previous: 'Press the new key for editor.lineEnd',
    next: 'ctrl+a is used by editor.lineStart. Replace it?',
    row: '',
  },
  {
    flow: '/resume',
    step: 'a conversation → the conversation shown, read later',
    given: () => ({ options: { ...SIGNED_IN, conversations: [CONVERSATION] } }),
    reach: async (driver) => {
      await opened(driver, '/resume', RESUME_PICKER_TITLE);
      await toRow(driver, 'add tests');
    },
    previous: RESUME_PICKER_TITLE,
    next: 'Three tests added.',
    row: 'add tests',
    holdOn: (driver) => hold(driver.backend, 'resumeSession'),
    read: true,
  },
  {
    flow: 'conversation pick at launch',
    step: 'a conversation → the conversation shown, read later',
    given: () => ({ options: { ...SIGNED_IN, conversations: [CONVERSATION] }, extra: { reopen: { kind: 'pick' } }, ready: RESUME_PICKER_TITLE }),
    reach: async (driver) => {
      await toRow(driver, 'add tests');
    },
    previous: RESUME_PICKER_TITLE,
    next: 'Three tests added.',
    row: 'add tests',
    holdOn: (driver) => hold(driver.backend, 'resumeSession'),
    read: true,
  },
  {
    flow: '/skills',
    step: 'Create from a template → the name field',
    given: () => ({ options: { ...SIGNED_IN, skills: [SKILL] } }),
    reach: async (driver) => {
      await opened(driver, '/skills', SKILLS_TITLE);
      await toRow(driver, CREATE_FROM_TEMPLATE_ROW);
    },
    previous: CREATE_FROM_TEMPLATE_ROW,
    next: TEMPLATE_NAME_TITLE,
    row: CREATE_FROM_TEMPLATE_ROW,
    field: true,
  },
  {
    flow: '/skills',
    step: 'a skill file → its list',
    given: () => ({ options: { ...SIGNED_IN, skills: [SKILL] } }),
    reach: async (driver) => {
      await opened(driver, '/skills', SKILLS_TITLE);
      await toRow(driver, 'pdf');
    },
    previous: CREATE_FROM_TEMPLATE_ROW,
    next: OPEN_IN_EDITOR_ROW,
    row: 'pdf',
  },
  {
    flow: '/agents',
    step: 'Create from a template → the name field',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await opened(driver, '/agents', AGENTS_TITLE);
      await toRow(driver, CREATE_FROM_TEMPLATE_ROW);
    },
    previous: CREATE_FROM_TEMPLATE_ROW,
    next: TEMPLATE_NAME_TITLE,
    row: CREATE_FROM_TEMPLATE_ROW,
    field: true,
  },
  {
    flow: 'history search (ctrl+r)',
    step: 'a history row → the prompt holds it',
    given: () => SIGNED_IN,
    reach: async (driver) => {
      await driver.step(KEYS.ctrlR, HISTORY_SEARCH_TITLE);
      await toRow(driver, 'an earlier prompt');
    },
    previous: HISTORY_SEARCH_TITLE,
    next: (frame) => !frame.includes(HISTORY_SEARCH_TITLE) && frame.includes('> an earlier prompt'),
    row: 'an earlier prompt',
  },
];

export type Ending = {
  readonly flow: string;
  readonly given: () => FakePlanOptions | StartGiven;
  readonly reach: (driver: AtRealTiming) => Promise<void>;
  readonly list: Shown;
  readonly choose?: string;
  readonly holdOn: (driver: AtRealTiming) => Held;
  readonly saved: (driver: AtRealTiming) => boolean;
  readonly result: Shown;
};

export const heldPort = () => {
  const gate = Promise.withResolvers<void>();
  const saves: string[] = [];
  const port = {
    initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true },
    save: async (name: string, value: unknown) => {
      saves.push(`${name}:${String(value)}`);
      await gate.promise;
    },
  } as const;
  return { port, saves, release: () => gate.resolve() };
};

export const endings = (): readonly Ending[] => {
  const theme = heldPort();
  return [
    {
      flow: '/mode',
      given: () => SIGNED_IN,
      reach: async (driver) => {
        await opened(driver, '/mode', 'Permission mode');
        await toRow(driver, 'acceptEdits');
      },
      list: 'Permission mode',
      holdOn: (driver) => hold(driver.backend, 'setMode'),
      saved: (driver) => driver.backend.calls.some((call) => call.startsWith('mode:')),
      result: 'mode: acceptEdits',
    },
    {
      flow: '/effort',
      given: () => SIGNED_IN,
      reach: async (driver) => {
        await opened(driver, '/effort', EFFORT_PICKER);
        await toRow(driver, 'high');
      },
      list: EFFORT_PICKER,
      choose: KEYS.tab,
      holdOn: (driver) => hold(driver.backend, 'setEffort'),
      saved: (driver) => driver.backend.calls.some((call) => call.startsWith('effort:')),
      result: 'effort: high',
    },
    {
      flow: '/logout',
      given: () => SIGNED_IN,
      reach: async (driver) => {
        await opened(driver, '/logout', (frame) => frame.includes('Sign out') && /\d+\. /.test(frame));
        await driver.step(KEYS.enter, 'again to sign out');
      },
      list: 'again to sign out',
      holdOn: (driver) => hold(driver.backend.plan, 'signOut'),
      saved: (driver) => driver.backend.planCalls.some((call) => call.route.includes('sign-out') || call.route.includes('signOut') || call.route.includes('logout')),
      result: 'Signed out chatgpt',
    },
    {
      flow: '/model switch',
      given: () => SIGNED_IN,
      reach: async (driver) => {
        await opened(driver, '/model', MODEL_LIST);
        await toRow(driver, 'gpt-6-luna');
        await driver.step(KEYS.enter, EFFORT_PICKER);
      },
      list: EFFORT_PICKER,
      holdOn: (driver) => hold(driver.backend, 'setModel'),
      saved: (driver) => driver.backend.calls.some((call) => call.startsWith('model:')),
      result: 'model: gpt-6-luna (effort: medium); applies from the next run',
    },
    {
      flow: '/login set active',
      given: () => ({ options: { ...SIGNED_IN, accounts: [account(), account({ label: 'work', active: false })] } }),
      reach: async (driver) => {
        await opened(driver, '/login chatgpt', PICKER);
        await toRow(driver, 'work');
      },
      list: PICKER,
      holdOn: (driver) => hold(driver.backend.plan, 'setActive'),
      saved: (driver) => driver.backend.planCalls.some((call) => call.route.includes('active')),
      result: 'work',
    },
    {
      flow: '/theme',
      given: () => ({ options: SIGNED_IN, extra: { tuiSettings: theme.port as never } }),
      reach: async (driver) => {
        await opened(driver, '/theme', 'Theme');
        await toRow(driver, 'dark');
      },
      list: (frame) => frame.includes('Theme') && frame.includes('esc: go back'),
      holdOn: () => ({ release: theme.release, calls: () => theme.saves.length }),
      saved: () => theme.saves.length > 0,
      result: 'theme',
    },
  ];
};

export const SECOND_ENTER: Readonly<Record<string, { readonly opened: string; readonly acted: string }>> = {
  "models hub: Add a model → its list of ways": { opened: "Add a model / › 1. Search this computer for model servers", acted: "No model server answered on this computer. / › 1. Type the address of a model server" },
  "models add: Type the address of a model server → the address field": { opened: "Address (for example http://127.0.0.1:11434): / >", acted: "Address (for example http://127.0.0.1:11434): / >" },
  "models add: Use a service with an API key → the list of APIs": { opened: "Use a service with an API key / › 1. OpenAI-compatible API", acted: "Address: / >" },
  "models add: Run a program as a model server → the program field": { opened: "Write the full path of the program. / >", acted: "Write the full path of the program. / >" },
  "models fields: a model of the hub → its fields": { opened: "ollama/qwen3.8:27b · 8.2k tokens · local · starts new sessions / › 1. Edit", acted: "Models /  Servers" },
  "/login: Add an API key → the list of APIs": { opened: "Use a service with an API key / › 1. OpenAI-compatible API", acted: "Address: / >" },
  "/login: OpenAI-compatible API → Address field": { opened: "Address: / >", acted: "Address: / >" },
  "/login provider flow: Rename account → its text field": { opened: "Rename account chatgpt / > chatgpt", acted: "Rename account chatgpt / > chatgpt" },
  "/login provider flow: Add another account → the label field": { opened: "Label for the new account or workspace / The workspace is chosen in the browser; each account or workspace is saved under its own label.", acted: ">" },
  "/config: the none choice → the question before the sandbox is turned off": { opened: "Run commands without a sandbox? / › 1. No", acted: "Settings / filter:" },
  "/config collection: Verification commands → its collection list": { opened: "Verification commands (user) / › 1. Add", acted: "Verification commands / >" },
  "/config collection: Add → its text field": { opened: "Verification commands / >", acted: "Verification commands / >" },
  "/config collection: Add of a form (Prices) → its first field": { opened: "Prices: Provider / >", acted: "Prices: Provider / >" },
  "/config collection: an entry → its action list": { opened: "npm run lint / › 1. Move up", acted: "Verification commands (user) / › 1. npm run lint" },
  "/config collection: delete on an entry → the remove question": { opened: "Remove npm run lint? / › 1. No", acted: "Verification commands (user) / › 1. npm run lint" },
  "/permissions: Allow rules → its rule list": { opened: "Allow rules / › 1. Add", acted: "Allow rules / Allowed: Bash(npm test:*)" },
  "/permissions: Add → the rule text field": { opened: "Allow rules / Allowed: Bash(npm test:*)", acted: "Allow rules / Allowed: Bash(npm test:*)" },
  "/permissions: delete on a rule → the remove question": { opened: "Remove Bash(npm run lint) from <place> / › 1. No", acted: "Allow rules / › 1. Bash(npm run lint) user" },
  "/hooks: Add → the event list": { opened: "Run the hook on / › 1. PreToolUse", acted: "Matcher (empty: every tool) / >" },
  "/hooks: an event → the matcher field": { opened: "Matcher (empty: every tool) / >", acted: "Command / >" },
  "/hooks: delete on a hook → the remove question": { opened: "Remove Stop * say done timeout 5 s user? / › 1. No", acted: "Hooks / › 1. Stop * say done timeout 5 s user" },
  "/mcp: Add a stdio server → the name field": { opened: "Name of the server / >", acted: "Name of the server / >" },
  "/mcp: the name field → the command field": { opened: "Command / >", acted: "Command / >" },
  "/mcp: a server of the user file → the remove question": { opened: "Remove files? / › 1. No", acted: "MCP servers / › 1. files user stdio not_required" },
  "/mcp: a server of the project → its enable/disable list": { opened: "tracker / › 1. Enable", acted: "MCP servers / applies from the next session" },
  "/keybindings: an action row → the key capture": { opened: "Press the new key for history.search (esc cancels, backspace removes the keys)", acted: "enter is used by prompt.submit. Replace it? / › 1. Replace" },
  "/keybindings: Reset all to the defaults → its question": { opened: "Reset every key binding to the defaults? /  1. Reset", acted: "Key bindings / filter:" },
  "/keybindings: a key another action uses, captured → the Replace question": { opened: "ctrl+a is used by editor.lineStart. Replace it? / › 1. Replace", acted: "Key bindings / filter:" },
  "/skills: Create from a template → the name field": { opened: "Name (lowercase letters, digits and single hyphens) / >", acted: "Name (lowercase letters, digits and single hyphens) / >" },
  "/agents: Create from a template → the name field": { opened: "Name (lowercase letters, digits and single hyphens) / >", acted: "Name (lowercase letters, digits and single hyphens) / >" },
};
