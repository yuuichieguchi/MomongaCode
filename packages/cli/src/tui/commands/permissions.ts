import { checkRuleText, RuleParseError } from '@momonga/config';
import type { SettingsLayer, SettingsSnapshot } from '@momonga/config';
import { GIT_DIRECTORY_ENTRIES, WORKSPACE_CONTROL_NAMES } from '@momonga/foundation';
import { PERMISSION_MODES, PERMISSION_MODE_DESCRIPTIONS } from '@momonga/protocol';
import { APPLIES_NEXT_SESSION, APPLIES_NOW, REMOVE_ACTIONS, chooseSaveTarget, chosenAction, currentOf, removeQuestion, runCollection, writeSetting } from '../settings-screen.tsx';
import type { Removal } from '../settings-screen.tsx';
import type { TrustView } from '../../client/views.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';

export const PERMISSIONS_TITLE = 'Permissions';
export const START_MODE_ROW = 'Start mode';
export const DIRECTORIES_ROW = 'Additional directories';
export const PROTECTED_HEADING = 'Always protected';
export const TRUST_ROW = 'Folder trust';
export const TRUST_TITLE = 'Do you trust the files of this folder? Its own settings, hooks, MCP servers and mandate are loaded only when it is trusted.';
export const NOT_DECIDED = 'not decided';
export const TRUST_ACTIONS = [
  { label: 'Trust this folder', decision: 'trusted' },
  { label: 'Do not trust this folder', decision: 'untrusted' },
  { label: 'Clear the decision: the next start asks again', decision: null },
] as const;
export const RULE_KINDS = [
  { effect: 'allow', row: 'Allow rules', preview: 'Allowed' },
  { effect: 'ask', row: 'Ask rules', preview: 'Asks' },
  { effect: 'deny', row: 'Deny rules', preview: 'Denied' },
] as const;

type RuleKind = (typeof RULE_KINDS)[number];

export const PROTECTED_LINES: readonly string[] = [
  `in the workspace: ${WORKSPACE_CONTROL_NAMES.join(', ')}`,
  `in a Git directory: ${GIT_DIRECTORY_ENTRIES.join(', ')}`,
  'a change to these is asked of a person in every mode',
  'adding a standing rule is asked of a person in every mode',
];

const TRUST_ROW_INDEX = RULE_KINDS.length + 2;

const START_MODE_PATH = ['permissions', 'defaultMode'] as const;

type Held = { readonly layer: SettingsLayer; readonly file: string; readonly text: string };

const heldAt = (snapshot: SettingsSnapshot, key: string): Held[] =>
  snapshot.layers.flatMap((view) => {
    const permissions = view.document['permissions'];
    const list = typeof permissions === 'object' && permissions !== null ? (permissions as Readonly<Record<string, unknown>>)[key] : undefined;
    return Array.isArray(list) ? list.filter((text): text is string => typeof text === 'string').map((text) => ({ layer: view.layer, file: view.file, text })) : [];
  });

const removed = (text: string) => (current: unknown): unknown => {
  const next = Array.isArray(current) ? (current as unknown[]).filter((member) => member !== text) : [];
  return next.length === 0 ? undefined : next;
};

const heldLine = (held: Held): string => `${held.text}  ${held.layer}`;

const actionsOf = async (context: SlashContext, held: Held | undefined): Promise<'left' | 'remove'> => (held === undefined || (await chosenAction(context, heldLine(held), REMOVE_ACTIONS)) === undefined ? 'left' : 'remove');

const removalOf = (held: Held | undefined, key: string): Removal | undefined =>
  held === undefined ? undefined : { question: removeQuestion(`${held.text} from ${held.file}`), remove: (context) => writeSetting(context, held.layer, { kind: 'update', path: ['permissions', key], update: removed(held.text) }) };

const ruleProblem = (text: string): string | undefined => {
  try {
    checkRuleText(text);
    return undefined;
  } catch (error) {
    if (!(error instanceof RuleParseError)) throw error;
    return error.message;
  }
};

const editRules = (context: SlashContext, kind: RuleKind): Promise<boolean> =>
  runCollection(context, {
    title: kind.row,
    applied: APPLIES_NOW,
    entries: (snapshot) => heldAt(snapshot, kind.effect).map(heldLine),
    add: async (_context, snapshot) => {
      const rule = await context.overlays.promptText({ title: kind.row, lines: [`${kind.preview}: Bash(npm test:*)`], validate: ruleProblem });
      if (rule === undefined) return 'left';
      const layer = await chooseSaveTarget(context, snapshot);
      if (layer === undefined) return 'left';
      const refusal = await writeSetting(context, layer, { kind: 'addRule', effect: kind.effect, rule });
      if (refusal === undefined) context.info(`${kind.preview}: ${rule}`);
      return refusal;
    },
    act: (_context, snapshot, index) => actionsOf(context, heldAt(snapshot, kind.effect)[index]),
    removal: (snapshot, index) => removalOf(heldAt(snapshot, kind.effect)[index], kind.effect),
  });

const editDirectories = (context: SlashContext): Promise<boolean> =>
  runCollection(context, {
    title: DIRECTORIES_ROW,
    applied: APPLIES_NOW,
    entries: (snapshot) => heldAt(snapshot, 'additionalDirectories').map(heldLine),
    add: async (_context, snapshot) => {
      const directory = await context.overlays.promptText({ title: DIRECTORIES_ROW, validate: (text) => (text.trim() === '' ? 'expected a directory' : undefined) });
      if (directory === undefined) return 'left';
      const layer = await chooseSaveTarget(context, snapshot);
      if (layer === undefined) return 'left';
      return writeSetting(context, layer, { kind: 'update', path: ['permissions', 'additionalDirectories'], update: (current) => [...(Array.isArray(current) ? (current as unknown[]) : []), directory] });
    },
    act: (_context, snapshot, index) => actionsOf(context, heldAt(snapshot, 'additionalDirectories')[index]),
    removal: (snapshot, index) => removalOf(heldAt(snapshot, 'additionalDirectories')[index], 'additionalDirectories'),
  });

const editStartMode = async (context: SlashContext, snapshot: SettingsSnapshot): Promise<string | undefined> => {
  const current = currentOf(snapshot, START_MODE_PATH).value;
  const choice = await context.overlays.choose({
    title: START_MODE_ROW,
    rows: PERMISSION_MODES.map((mode) => ({ label: `${mode}  ${PERMISSION_MODE_DESCRIPTIONS[mode]}` })),
    initial: Math.max(0, PERMISSION_MODES.findIndex((mode) => mode === current)),
    decideOn: 'enter',
    escape: 'back',
    filter: false,
  });
  const mode = choice === undefined ? undefined : PERMISSION_MODES[choice.index];
  if (mode === undefined) return undefined;
  const layer = await chooseSaveTarget(context, snapshot);
  if (layer === undefined) return undefined;
  const refusal = await writeSetting(context, layer, { kind: 'set', path: START_MODE_PATH, value: mode });
  return refusal === undefined ? `${START_MODE_ROW}: ${mode}  ${APPLIES_NEXT_SESSION}` : refusal.refused;
};

const trustShown = (trust: TrustView): string => `${trust.decision ?? NOT_DECIDED}${trust.inheritedFrom === undefined ? '' : `  from ${trust.inheritedFrom}`}`;

const editTrust = async (context: SlashContext, trust: TrustView): Promise<string | undefined> => {
  const choice = await context.overlays.choose({
    title: TRUST_TITLE,
    lines: [`${trust.path}: ${trustShown(trust)}`],
    rows: TRUST_ACTIONS.map((action) => ({ label: action.label })),
    initial: Math.max(0, TRUST_ACTIONS.findIndex((action) => action.decision === trust.decision)),
    decideOn: 'enter',
    escape: 'back',
    filter: false,
  });
  const action = choice === undefined ? undefined : TRUST_ACTIONS[choice.index];
  if (action === undefined) return undefined;
  if (action.decision === null) await context.backend.clearTrust();
  else await context.backend.decideTrust(action.decision);
  return `${TRUST_ROW}: ${action.decision ?? NOT_DECIDED}  ${APPLIES_NEXT_SESSION}`;
};

const startModeLabel = (snapshot: SettingsSnapshot): string => {
  const { value, source } = currentOf(snapshot, START_MODE_PATH);
  return `${START_MODE_ROW}  ${typeof value === 'string' ? value : PERMISSION_MODES[0]}  ${source}`;
};

export const permissionsCommand: SlashCommand = {
  name: 'permissions',
  description: 'show and change the start mode, the allow, ask and deny rules, the additional directories and the trust of this folder',
  needsSession: false,
  run: async (_args, context) => {
    let at = 0;
    let line: string | undefined;
    for (;;) {
      const snapshot = await context.backend.settings();
      const trust = await context.backend.trust();
      const choice = await context.overlays.choose({
        title: PERMISSIONS_TITLE,
        lines: line === undefined ? [] : [line],
        rows: [
          { label: startModeLabel(snapshot) },
          ...RULE_KINDS.map((kind) => ({ label: `${kind.row}  ${heldAt(snapshot, kind.effect).length}` })),
          { label: `${DIRECTORIES_ROW}  ${heldAt(snapshot, 'additionalDirectories').length}` },
          { label: `${TRUST_ROW}  ${trustShown(trust)}` },
          { label: PROTECTED_HEADING, separator: true },
          ...PROTECTED_LINES.map((label) => ({ label, separator: true })),
        ],
        initial: at,
        decideOn: 'enter',
        escape: 'back',
        filter: false,
      });
      if (choice === undefined) return;
      at = choice.index;
      line = undefined;
      const kind = RULE_KINDS[choice.index - 1];
      if (choice.index === 0) line = await editStartMode(context, snapshot);
      else if (kind !== undefined) await editRules(context, kind);
      else if (choice.index === TRUST_ROW_INDEX) line = await editTrust(context, trust);
      else await editDirectories(context);
    }
  },
};
