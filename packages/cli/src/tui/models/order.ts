import { durationText, editModelsSettings } from '@momonga/config';
import type { TargetBilling } from '@momonga/protocol';
import { SEPARATOR, START_MARK, billingRows, displayIn, fallbackRows, proposeForm, roleRows } from '../../commands/models.ts';
import type { ModelsEdit, ModelsProposal } from '../../commands/models.ts';
import { chosenOf, confirmAndWrite, confirmedBy, openEdit, proposeAndWrite, refusedSentence } from './context.ts';
import type { ModelsFlowContext, Opened } from './context.ts';
import {
  BILLING_TITLE,
  EVERY_MODEL_ROW,
  FALLBACK_ACTIONS,
  FALLBACK_ADD_ROW,
  FALLBACK_TITLE,
  FIRST_MODEL_ROW,
  FORBID_ROW,
  MINUTES_PROBLEM,
  MINUTES_PROMPT,
  ROLE_ROWS,
  ROLE_TITLE,
  SAVING_PHASE,
  SESSION_MODEL_ROW,
  START_TITLE,
  TIMEOUTS_TITLE,
  billingQuestion,
  billingScopeQuestion,
  headersWaitRow,
  idleWaitRow,
  onlyModelRow,
} from './texts.ts';

const CHAIN_ARROW = ' → ';

const canonsOf = (edit: ModelsEdit): string[] => edit.resolved.views.map((view) => view.canon);

export const runStartFlow = async (context: ModelsFlowContext): Promise<boolean> => {
  const opened = await openEdit(context);
  const { edit } = opened;
  const canons = canonsOf(edit);
  const rows = [...canons.map((canon) => ({ label: `${displayIn(edit, canon)}${canon === edit.resolved.start ? `${SEPARATOR}${START_MARK}` : ''}` })), { label: FIRST_MODEL_ROW }];
  const index = await chosenOf(context, { title: START_TITLE, rows });
  if (index === undefined) return false;
  const canon = canons[index];
  const written = await proposeAndWrite(opened, context, 'start', canon === undefined ? { args: [], options: { clear: true } } : { args: [canon], options: {} });
  return written !== undefined;
};

export const writeStart = async (context: Pick<ModelsFlowContext, 'backend' | 'info' | 'wait'>, model: string): Promise<void> => {
  const host = context.backend.modelsHost(new AbortController().signal, context.info);
  await context.wait(SAVING_PHASE, (signal) => editModelsSettings(host.home, host.settingsFile, [{ kind: 'setStart', model }], { lock: host.lock(), signal }));
};

export const sessionChainText = (edit: ModelsEdit, model: string | undefined): string | undefined => {
  const chain = model === undefined ? undefined : edit.resolved.chains.get(model);
  return chain === undefined ? undefined : chain.map((canon) => displayIn(edit, canon)).join(CHAIN_ARROW);
};

type BillingStep = { from: TargetBilling; to: TargetBilling; server: string };

const billingStepOf = (edit: ModelsEdit, added: string): BillingStep | undefined => {
  const before = edit.resolved.fallback.filter((canon) => canon !== added).at(-1) ?? edit.resolved.start;
  const from = before === undefined ? undefined : edit.resolved.models.get(before);
  const to = edit.resolved.models.get(added);
  if (from === undefined || to === undefined || from.billing === to.billing) return undefined;
  const allowed = edit.resolved.billingChanges.some((change) => change.from === from.billing && change.to === to.billing && (change.model === undefined || change.model === added));
  return allowed ? undefined : { from: from.billing, to: to.billing, server: to.provider };
};

const withBillingChange = async (context: ModelsFlowContext, edit: ModelsEdit, added: string, proposal: ModelsProposal): Promise<ModelsProposal> => {
  const step = billingStepOf(edit, added);
  if (step === undefined || !(await confirmedBy(context, billingQuestion(step.from, step.to, step.server)))) return proposal;
  const display = displayIn(edit, added);
  const scope = await chosenOf(context, { title: billingScopeQuestion(display), rows: [{ label: EVERY_MODEL_ROW }, { label: onlyModelRow(display) }] });
  if (scope === undefined) return proposal;
  return { operations: [...proposal.operations, { kind: 'allowBillingChange', from: step.from, to: step.to, ...(scope === 1 ? { model: added } : {}) }], confirm: proposal.confirm };
};

const addFallback = async (context: ModelsFlowContext, opened: Opened): Promise<void> => {
  const { edit, host } = opened;
  const offered = canonsOf(edit).filter((canon) => !edit.resolved.fallback.includes(canon));
  const index = await chosenOf(context, { title: FALLBACK_ADD_ROW, rows: offered.map((canon) => ({ label: displayIn(edit, canon) })) });
  const added = index === undefined ? undefined : offered[index];
  if (added === undefined) return;
  const proposal = await refusedSentence(context, () => proposeForm(host, edit, 'fallback add', { args: [added], options: {} }));
  if (proposal === undefined) return;
  await confirmAndWrite(opened, context, await withBillingChange(context, edit, added, proposal.value));
};

const changeFallback = async (context: ModelsFlowContext, opened: Opened, position: number): Promise<void> => {
  const { edit } = opened;
  const member = edit.resolved.fallback[position];
  if (member === undefined) return;
  const action = await chosenOf(context, { title: displayIn(edit, member), rows: FALLBACK_ACTIONS.map((label) => ({ label })) });
  const chosen = action === undefined ? undefined : FALLBACK_ACTIONS[action];
  if (chosen === undefined) return;
  if (chosen === 'Remove') {
    await proposeAndWrite(opened, context, 'fallback remove', { args: [member], options: {} });
    return;
  }
  const to = chosen === 'Move up' ? position : position + 2;
  if (to < 1 || to > edit.resolved.fallback.length) return;
  await proposeAndWrite(opened, context, 'fallback move', { args: [member], options: { to: String(to) } });
};

export const runFallbackFlow = async (context: ModelsFlowContext): Promise<void> => {
  for (;;) {
    const opened = await openEdit(context);
    const { edit } = opened;
    const members = edit.resolved.fallback;
    const chain = sessionChainText(edit, context.model);
    const lines = [...(members.length === 0 ? fallbackRows(edit) : []), ...(chain === undefined ? [] : [chain])];
    const rows = [...(members.length === 0 ? [] : fallbackRows(edit)).map((label) => ({ label })), { label: FALLBACK_ADD_ROW }];
    const index = await chosenOf(context, { title: FALLBACK_TITLE, lines, rows });
    if (index === undefined) return;
    if (index === members.length) await addFallback(context, opened);
    else await changeFallback(context, opened, index);
  }
};

export const runBillingFlow = async (context: ModelsFlowContext): Promise<void> => {
  for (;;) {
    const opened = await openEdit(context);
    const { edit } = opened;
    const changes = edit.resolved.billingChanges;
    if (changes.length === 0) {
      context.info(billingRows(edit).join('\n'));
      return;
    }
    const index = await chosenOf(context, { title: BILLING_TITLE, rows: billingRows(edit).map((label) => ({ label })) });
    const change = index === undefined ? undefined : changes[index];
    if (change === undefined) return;
    const action = await chosenOf(context, { title: billingRows(edit)[index ?? 0] ?? BILLING_TITLE, rows: [{ label: FORBID_ROW }] });
    if (action === undefined) continue;
    await proposeAndWrite(opened, context, 'billing forbid', { args: [change.from, change.to], options: change.model === undefined ? {} : { model: change.model } });
  }
};

type Job = (typeof ROLE_ROWS)[number]['job'];

export const chooseRoleModel = async (context: ModelsFlowContext, opened: Opened, job: Job, label: string): Promise<boolean> => {
  const { edit } = opened;
  const canons = canonsOf(edit);
  const index = await chosenOf(context, { title: label, rows: [...canons.map((canon) => ({ label: displayIn(edit, canon) })), { label: SESSION_MODEL_ROW }] });
  if (index === undefined) return false;
  const canon = canons[index];
  const written = canon === undefined ? await proposeAndWrite(opened, context, 'role clear', { args: [job], options: {} }) : await proposeAndWrite(opened, context, 'role set', { args: [job, canon], options: {} });
  return written !== undefined;
};

export const runRoleFlow = async (context: ModelsFlowContext): Promise<void> => {
  for (;;) {
    const opened = await openEdit(context);
    const index = await chosenOf(context, { title: ROLE_TITLE, rows: roleRows(opened.edit).map((label) => ({ label })) });
    const row = index === undefined ? undefined : ROLE_ROWS[index];
    if (row === undefined) return;
    await chooseRoleModel(context, opened, row.job, row.label);
  }
};

export const runClassifierFlow = async (context: ModelsFlowContext): Promise<void> => {
  const row = ROLE_ROWS.find((candidate) => candidate.job === 'classifier');
  if (row === undefined) throw new TypeError('the jobs hold no classifier row');
  await chooseRoleModel(context, await openEdit(context), row.job, row.label);
};

const WHOLE_MINUTES = /^\d+$/;

export const runTimeoutsFlow = async (context: ModelsFlowContext): Promise<void> => {
  for (;;) {
    const opened = await openEdit(context);
    const { resolved } = opened.edit;
    const rows = [{ label: headersWaitRow(durationText(resolved.headersTimeoutMs)) }, { label: idleWaitRow(durationText(resolved.idleTimeoutMs)) }];
    const index = await chosenOf(context, { title: TIMEOUTS_TITLE, rows });
    if (index === undefined) return;
    const minutes = await context.overlays.promptText({ title: MINUTES_PROMPT, validate: (text) => (WHOLE_MINUTES.test(text.trim()) ? undefined : MINUTES_PROBLEM) });
    if (minutes === undefined) continue;
    await proposeAndWrite(opened, context, 'timeouts', { args: [], options: { [index === 0 ? 'headers' : 'idle']: minutes.trim() } });
  }
};
