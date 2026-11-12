import { openInEditor } from '../external-editor.ts';
import { REASONS, TEXT_CONTEXTS, withAllDefaults, withBinding, withDefaultsOf, withoutKeysOf } from '../keys/bindings.ts';
import type { BindingEntry, BindingReport } from '../keys/bindings.ts';
import { captureTitle } from '../keys/capture.ts';
import { KEY_FILE_UNAVAILABLE } from '../keys/store.ts';
import type { KeyBindings, KeyEdit } from '../keys/store.ts';
import { isPlainKey, KEYS, KEY_CONTEXTS, keyReported, needsReport, shownKey } from '../keys/table.ts';
import type { ActionRow, KeySpec } from '../keys/table.ts';
import type { OverlayPorts, PickRow } from '../picker.tsx';
import type { SlashCommand, SlashContext } from '../slash.ts';
import type { NegotiationState } from '../terminal/negotiation.ts';

export type KeyBindingsScreen = { readonly store: KeyBindings } & Pick<OverlayPorts, 'choose' | 'captureKey'>;

export const KEYBINDINGS_TITLE = 'Key bindings';
export const OPEN_FILE_ROW = 'Open the file';
export const RESET_ALL_ROW = 'Reset all to the defaults';
export const RESET_ONE_LABEL = 'reset to the defaults';
export const REPLACE_ROWS = ['Replace', 'Cancel'] as const;
export const SAVING_KEYS = 'saving the key bindings';
export const NO_KEY = 'no key';
export const CHANGED_MARK = '(changed)';
export const MAY_NOT_REPORT = '(this terminal may not report it)';
export const REJECTED_HEADING = 'entries of the file that were ignored';

export const replaceQuestion = (key: KeySpec, action: string): string => `${shownKey(key)} is used by ${action}. Replace it?`;

export const rejectedLine = (entry: BindingEntry): string => `${entry.context}: ${entry.key} -> ${entry.action ?? 'null'}  rejected: ${entry.rejected ?? ''}`;

const defaultsOf = (row: ActionRow): readonly KeySpec[] => KEYS.find((base) => base.id === row.id)?.default ?? [];

const sameKeys = (left: readonly KeySpec[], right: readonly KeySpec[]): boolean => left.length === right.length && left.every((key) => right.includes(key));

export const actionRowLabel = (row: ActionRow, negotiation: NegotiationState): string => {
  const keys = row.default.length === 0 ? NO_KEY : row.default.map(shownKey).join(', ');
  const marks = [
    ...(sameKeys(row.default, defaultsOf(row)) ? [] : [CHANGED_MARK]),
    ...(row.default.some((key) => needsReport(key) && !keyReported(key, negotiation)) ? [MAY_NOT_REPORT] : []),
  ];
  return [`${row.id}  ${keys}  ${row.description}`, ...marks].join(' ');
};

type Listed = { readonly kind: 'open' } | { readonly kind: 'reset-all' } | { readonly kind: 'action'; readonly row: ActionRow } | { readonly kind: 'heading' };

export const keybindingRows = (report: BindingReport, negotiation: NegotiationState): { rows: PickRow[]; listed: Listed[] } => {
  const rows: PickRow[] = [{ label: OPEN_FILE_ROW }, { label: RESET_ALL_ROW }];
  const listed: Listed[] = [{ kind: 'open' }, { kind: 'reset-all' }];
  for (const context of KEY_CONTEXTS) {
    const inContext = report.rows.filter((row) => row.context === context);
    if (inContext.length === 0) continue;
    rows.push({ label: context, separator: true });
    listed.push({ kind: 'heading' });
    for (const row of inContext) {
      rows.push({ label: actionRowLabel(row, negotiation) });
      listed.push({ kind: 'action', row });
    }
  }
  return { rows, listed };
};

export const keybindingLines = (report: BindingReport, shownFile: string): string[] => {
  const rejected = report.entries.filter((entry) => entry.rejected !== undefined);
  return [...(report.fileProblem === undefined ? [] : [`${shownFile} was ignored: ${report.fileProblem}`]), ...(rejected.length === 0 ? [] : [REJECTED_HEADING, ...rejected.map(rejectedLine)])];
};

const rejectionOf = (report: BindingReport, row: ActionRow, spec: KeySpec): string | undefined => report.entries.find((entry) => entry.context === row.context && entry.spec === spec && entry.action === row.id)?.rejected;

const save = async (context: SlashContext, edit: KeyEdit): Promise<void> => {
  await context.background(SAVING_KEYS, () => context.keyBindings.store.change(edit));
};

const bind = async (context: SlashContext, row: ActionRow, spec: KeySpec): Promise<void> => {
  const { store, choose } = context.keyBindings;
  const holder = store.report().rows.find((other) => other.context === row.context && other.id !== row.id && other.default.includes(spec));
  if (holder !== undefined) {
    const answer = await choose({ title: replaceQuestion(spec, holder.id), rows: REPLACE_ROWS.map((label) => ({ label })), decideOn: 'enter', escape: REPLACE_ROWS.indexOf('Cancel'), filter: false });
    if (answer?.index !== REPLACE_ROWS.indexOf('Replace')) return;
  }
  const edit: KeyEdit = (document) => withBinding(document, row.context, spec, row.id);
  const rejected = rejectionOf(store.preview(edit), row, spec);
  if (rejected !== undefined) {
    context.info(`rejected: ${rejected}`);
    return;
  }
  await save(context, edit);
};

const unbind = async (context: SlashContext, row: ActionRow): Promise<void> => {
  const edit: KeyEdit = (document) => withoutKeysOf(document, { ...row, default: defaultsOf(row) }, row.default);
  const after = context.keyBindings.store.preview(edit).rows.find((other) => other.id === row.id);
  if (after !== undefined && after.default.length > 0) {
    context.info(`rejected: ${REASONS.noKey(row.id)}`);
    return;
  }
  await save(context, edit);
};

const rebind = async (context: SlashContext, row: ActionRow): Promise<void> => {
  const captured = await context.keyBindings.captureKey({
    title: captureTitle(row.id),
    problemOf: (spec) => (isPlainKey(spec) && TEXT_CONTEXTS.includes(row.context) ? REASONS.text(shownKey(spec), row.context) : undefined),
  });
  if (captured === undefined) return;
  if (captured.kind === 'remove') await unbind(context, row);
  else await bind(context, row, captured.spec);
};

export const keybindingsCommand: SlashCommand = {
  name: 'keybindings',
  description: 'show the keys of every action and change them; the changes are written to the key-binding file',
  needsSession: false,
  run: async (_args, context) => {
    const { store, choose } = context.keyBindings;
    let at = 0;
    for (;;) {
      const report = store.report();
      const { rows, listed } = keybindingRows(report, context.negotiation);
      const choice = await choose({
        title: KEYBINDINGS_TITLE,
        lines: keybindingLines(report, store.shownFile),
        rows,
        initial: at,
        decideOn: 'enter',
        escape: 'back',
        filter: true,
        alt: { label: RESET_ONE_LABEL },
      });
      const chosen = choice === undefined ? undefined : listed[choice.index];
      if (choice === undefined || chosen === undefined || chosen.kind === 'heading') return;
      at = choice.index;
      if (chosen.kind === 'open') {
        if (choice.alt) continue;
        if (store.file === undefined) {
          context.info(KEY_FILE_UNAVAILABLE);
          return;
        }
        await openInEditor(context.externalEditor, store.file, (text) => context.info(text));
        await store.load();
        continue;
      }
      if (chosen.kind === 'reset-all') {
        if (!choice.alt) await save(context, withAllDefaults);
        continue;
      }
      const { row } = chosen;
      if (choice.alt) await save(context, (document) => withDefaultsOf(document, { ...row, default: defaultsOf(row) }));
      else await rebind(context, row);
    }
  },
};
