import type { SettingsLayer, SettingsSnapshot } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import { HOOK_COMMAND_TYPE, HOOK_EVENTS, HOOK_MATCHER_EVENTS, hookMatcherError } from '@momonga/protocol';
import type { HookCommand, HookEvent, HookMatcherGroup } from '@momonga/protocol';
import { APPLIES_NOW, ENTRY_ACTIONS, chooseSaveTarget, chosenAction, removeQuestion, runCollection, writeSetting } from '../settings-screen.tsx';
import type { Refusal } from '../settings-screen.tsx';
import type { SlashCommand, SlashContext } from '../slash.ts';

export const HOOKS_TITLE = 'Hooks';
export const HOOK_EVENT_TITLE = 'Run the hook on';
export const HOOK_MATCHER_TITLE = 'Matcher (empty: every tool)';
export const HOOK_COMMAND_TITLE = 'Command';
export const HOOK_TIMEOUT_TITLE = 'Timeout (empty: none)';

type Held = { readonly layer: SettingsLayer; readonly event: string; readonly group: number; readonly hook: number; readonly matcher: string | undefined; readonly command: HookCommand };

const groupsOf = (value: unknown): HookMatcherGroup[] => (Array.isArray(value) ? (value as HookMatcherGroup[]) : []);

const heldHooks = (snapshot: SettingsSnapshot): Held[] =>
  snapshot.layers.flatMap((view) => {
    const hooks = view.document['hooks'];
    if (!isRecord(hooks)) return [];
    return Object.entries(hooks).flatMap(([event, groups]) =>
      groupsOf(groups).flatMap((group, groupIndex) => group.hooks.map((command, hookIndex) => ({ layer: view.layer, event, group: groupIndex, hook: hookIndex, matcher: group.matcher, command }))),
    );
  });

export const hookLine = (held: Held): string =>
  [held.event, held.matcher === undefined || held.matcher === '' ? '*' : held.matcher, held.command.command, ...(held.command.timeout === undefined ? [] : [`timeout ${held.command.timeout}`]), held.layer].join('  ');

const withoutHook = (held: Held) => (current: unknown): unknown => {
  const next = groupsOf(current).flatMap((group, groupIndex) => {
    if (groupIndex !== held.group) return [group];
    const hooks = group.hooks.filter((_, hookIndex) => hookIndex !== held.hook);
    return hooks.length === 0 ? [] : [{ ...group, hooks }];
  });
  return next.length === 0 ? undefined : next;
};

type Asked = { readonly matcher: string | undefined; readonly command: HookCommand };

const isMatcherEvent = (event: string): boolean => HOOK_MATCHER_EVENTS.some((known) => known === event);

const askHook = async (context: SlashContext, event: string, before: Asked | undefined): Promise<Asked | undefined> => {
  const { promptText } = context.overlays;
  const matcher = isMatcherEvent(event) ? await promptText({ title: HOOK_MATCHER_TITLE, initial: before?.matcher ?? '', validate: (text) => (text === '' ? undefined : hookMatcherError(text)) }) : '';
  if (matcher === undefined) return undefined;
  const command = await promptText({ title: HOOK_COMMAND_TITLE, initial: before?.command.command ?? '', validate: (text) => (text.trim() === '' ? 'expected a command' : undefined) });
  if (command === undefined) return undefined;
  const timeout = await promptText({
    title: HOOK_TIMEOUT_TITLE,
    initial: before?.command.timeout === undefined ? '' : String(before.command.timeout),
    validate: (text) => (text === '' || (/^\d+$/.test(text) && Number(text) >= 1) ? undefined : 'expected a whole number from 1'),
  });
  if (timeout === undefined) return undefined;
  return { matcher: matcher === '' ? undefined : matcher, command: { type: HOOK_COMMAND_TYPE, command, ...(timeout === '' ? {} : { timeout: Number(timeout) }) } };
};

const groupOf = (asked: Asked): HookMatcherGroup => ({ ...(asked.matcher === undefined ? {} : { matcher: asked.matcher }), hooks: [asked.command] });

const removeHook = (context: SlashContext, held: Held): Promise<Refusal | undefined> => writeSetting(context, held.layer, { kind: 'update', path: ['hooks', held.event], update: withoutHook(held) });

const replaceHook = (context: SlashContext, held: Held, asked: Asked): Promise<Refusal | undefined> =>
  writeSetting(context, held.layer, { kind: 'update', path: ['hooks', held.event], update: (current) => [...groupsOf(withoutHook(held)(current)), groupOf(asked)] });

const addHook = async (context: SlashContext, snapshot: SettingsSnapshot): Promise<Refusal | 'left' | undefined> => {
  const choice = await context.overlays.choose({ title: HOOK_EVENT_TITLE, rows: HOOK_EVENTS.map((label) => ({ label })), decideOn: 'enter', escape: 'back', filter: false });
  const event: HookEvent | undefined = choice === undefined ? undefined : HOOK_EVENTS[choice.index];
  if (event === undefined) return 'left';
  const asked = await askHook(context, event, undefined);
  if (asked === undefined) return 'left';
  const layer = await chooseSaveTarget(context, snapshot);
  if (layer === undefined) return 'left';
  return writeSetting(context, layer, { kind: 'update', path: ['hooks', event], update: (current) => [...groupsOf(current), groupOf(asked)] });
};

const actOnHook = async (context: SlashContext, held: Held | undefined): Promise<Refusal | 'left' | 'remove' | undefined> => {
  if (held === undefined) return 'left';
  const chosen = await chosenAction(context, hookLine(held), ENTRY_ACTIONS);
  if (chosen === undefined) return 'left';
  if (chosen === 'Remove') return 'remove';
  const asked = await askHook(context, held.event, held);
  return asked === undefined ? 'left' : replaceHook(context, held, asked);
};

export const hooksCommand: SlashCommand = {
  name: 'hooks',
  description: 'show the hooks by event and add, edit or remove one',
  needsSession: false,
  run: async (_args, context) => {
    await runCollection(context, {
      title: HOOKS_TITLE,
      applied: APPLIES_NOW,
      entries: (snapshot) => heldHooks(snapshot).map(hookLine),
      add: (_context, snapshot) => addHook(context, snapshot),
      act: (_context, snapshot, index) => actOnHook(context, heldHooks(snapshot)[index]),
      removal: (snapshot, index) => {
        const held = heldHooks(snapshot)[index];
        return held === undefined ? undefined : { question: removeQuestion(hookLine(held)), remove: () => removeHook(context, held) };
      },
    });
  },
};
