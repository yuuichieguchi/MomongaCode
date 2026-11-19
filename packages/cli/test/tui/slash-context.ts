import { DEFAULT_SLASH_COMMANDS } from '../../src/tui/commands/index.ts';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { fixedKeyBindings } from '../../src/tui/keys/store.ts';
import { createFoundServers } from '../../src/tui/models/context.ts';
import { NO_A11Y } from '../../src/tui/screen/a11y.ts';
import { createSlashRegistry } from '../../src/tui/slash.ts';
import type { SlashContext } from '../../src/tui/slash.ts';
import type { PickRequest, PickChoice } from '../../src/tui/picker.tsx';
import { SESSION, fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';

export type Recorded = { infos: string[]; toasts: string[]; modes: string[]; picks: PickRequest[]; opened: string[]; stored: [string, boolean][]; prompts: string[] };

export const contextOf = (overrides: Partial<SlashContext> = {}, backendOptions: FakeBackendOptions = {}, answers: { choices?: (PickChoice | undefined)[]; texts?: (string | undefined)[] } = {}) => {
  const recorded: Recorded = { infos: [], toasts: [], modes: [], picks: [], opened: [], stored: [], prompts: [] };
  const choices = [...(answers.choices ?? [])];
  const texts = [...(answers.texts ?? [])];
  const backend = fakeBackend(backendOptions);
  const context: SlashContext = {
    mode: 'manual',
    model: SESSION.model,
    effort: undefined,
    shownModel: (model: string) => model,
    setEffort: async () => undefined,
    found: createFoundServers(),
    wait: <T>(_phase: string, work: (signal: AbortSignal) => Promise<T>) => work(new AbortController().signal),
    toast: (text) => void recorded.toasts.push(text),
    refreshConnection: async () => undefined,
    bypassAllowed: true,
    autoAvailable: true,
    commands: DEFAULT_SLASH_COMMANDS,
    backend,
    startRun: async () => undefined,
    compact: async () => undefined,
    info: (text) => void recorded.infos.push(text),
    sessions: { startNew: async () => undefined, resume: async () => undefined, current: () => undefined, now: () => 0, columns: () => 80 },
    exit: () => undefined,
    setMode: async (mode) => void recorded.modes.push(mode),
    setModel: async () => undefined,
    background: (_label, work) => work(new AbortController().signal),
    autoMode: { check: async () => ({ measurement: 'passed' }), status: async () => ({ measurement: 'not_measured' }) },
    shell: { run: async () => 0 },
    screen: { current: () => 'fullscreen', set: async () => undefined },
    keys: DEFAULT_KEY_TABLE,
    negotiation: 'unknown',
    display: {
      theme: () => 'dark',
      previewTheme: () => undefined,
      storeTheme: async () => undefined,
      notify: () => 'off',
      storeNotify: async () => undefined,
      a11y: () => NO_A11Y,
      storedA11y: () => false,
      storeA11y: async () => undefined,
      storeTui: async (name, value) => void recorded.stored.push([name, value]),
      pick: async () => undefined,
    },
    keyBindings: { store: fixedKeyBindings(DEFAULT_KEY_TABLE), choose: async () => undefined, captureKey: async () => undefined },
    overlays: {
      choose: async (request) => {
        recorded.picks.push(request);
        return choices.shift();
      },
      promptText: async (request) => {
        recorded.prompts.push(request.title);
        return texts.shift();
      },
    },
    externalEditor: {
      open: async (file) => {
        recorded.opened.push(file);
        return { kind: 'opened' };
      },
    },
    clipboard: { selected: () => undefined, lastAnswer: () => undefined },
    refusedWhileRunning: () => false,
    status: () => [],
    ...overrides,
  };
  return { context, recorded, backend };
};

export const runSlash = (name: string, args: string, context: SlashContext) => {
  const command = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find(name);
  if (command === undefined) throw new Error(`/${name} is not in the registry`);
  return command.run(args, context);
};

