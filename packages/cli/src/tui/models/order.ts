import { INHERITED_CLASSIFIER, durationText, editModelsSettings, writeMemoryAutoReview } from '@momonga/config';
import type { ModelsEditResult } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import { modelsForJob } from '@momonga/protocol';
import type { ModelJob, TargetBilling } from '@momonga/protocol';
import type { MemoryAutoReviewState } from '../../memory/format.ts';
import { SEPARATOR, START_MARK, billingRows, displayIn, fallbackRows, proposeForm, roleRows } from '../../commands/models.ts';
import type { ModelsEdit, ModelsProposal } from '../../commands/models.ts';
import { chosenOf, chosenThen, confirmAndWrite, confirmedBy, openEdit, proposeAndWrite, refusedSentence } from './context.ts';
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
  MEMORY_REVIEW_MODEL_TITLE,
  MEMORY_REVIEW_ROW,
  MINUTES_PROMPT,
  NOT_SET,
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

const canonsOf = (edit: ModelsEdit, job?: ModelJob): string[] =>
  (job === undefined ? edit.resolved.views : modelsForJob(edit.resolved.views, job)).map((view) => view.canon);

export const runStartFlow = async (context: ModelsFlowContext): Promise<boolean> => {
  const opened = await openEdit(context);
  const { edit } = opened;
  const canons = canonsOf(edit, 'start');
  const rows = [...canons.map((canon) => ({ label: `${displayIn(edit, canon)}${canon === edit.resolved.start ? `${SEPARATOR}${START_MARK}` : ''}` })), { label: FIRST_MODEL_ROW }];
  const acted = await chosenThen(context, { title: START_TITLE, rows }, async (index) => {
    const canon = canons[index];
    const written = await proposeAndWrite(opened, context, 'start', canon === undefined ? { args: [], options: { clear: true } } : { args: [canon], options: {} });
    return written !== undefined;
  });
  return acted?.value === true;
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
  const offered = canonsOf(edit, 'fallback').filter((canon) => !edit.resolved.fallback.includes(canon));
  await chosenThen(context, { title: FALLBACK_ADD_ROW, rows: offered.map((canon) => ({ label: displayIn(edit, canon) })) }, async (index) => {
    const added = offered[index];
    if (added === undefined) return;
    const proposal = await refusedSentence(context, () => proposeForm(host, edit, 'fallback add', { args: [added], options: {} }));
    if (proposal === undefined) return;
    await confirmAndWrite(opened, context, await withBillingChange(context, edit, added, proposal.value));
  });
};

const changeFallback = async (context: ModelsFlowContext, opened: Opened, position: number): Promise<void> => {
  const { edit } = opened;
  const member = edit.resolved.fallback[position];
  if (member === undefined) return;
  await chosenThen(context, { title: displayIn(edit, member), rows: FALLBACK_ACTIONS.map((label) => ({ label })) }, async (action) => {
    const chosen = FALLBACK_ACTIONS[action];
    if (chosen === undefined) return;
    if (chosen === 'Remove') {
      await proposeAndWrite(opened, context, 'fallback remove', { args: [member], options: {} });
      return;
    }
    const to = chosen === 'Move up' ? position : position + 2;
    if (to < 1 || to > edit.resolved.fallback.length) return;
    await proposeAndWrite(opened, context, 'fallback move', { args: [member], options: { to: String(to) } });
  });
};

export const runFallbackFlow = async (context: ModelsFlowContext): Promise<void> => {
  for (;;) {
    const opened = await openEdit(context);
    const { edit } = opened;
    const members = edit.resolved.fallback;
    const chain = sessionChainText(edit, context.model);
    const lines = [...(members.length === 0 ? fallbackRows(edit) : []), ...(chain === undefined ? [] : [chain])];
    const rows = [...(members.length === 0 ? [] : fallbackRows(edit)).map((label) => ({ label })), { label: FALLBACK_ADD_ROW }];
    const acted = await chosenThen(context, { title: FALLBACK_TITLE, lines, rows }, async (index) => {
      if (index === members.length) await addFallback(context, opened);
      else await changeFallback(context, opened, index);
    });
    if (acted === undefined) return;
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
    const acted = await chosenThen(context, { title: BILLING_TITLE, rows: billingRows(edit).map((label) => ({ label })) }, async (index) => {
      const change = changes[index];
      if (change === undefined) return;
      await chosenThen(context, { title: billingRows(edit)[index] ?? BILLING_TITLE, rows: [{ label: FORBID_ROW }] }, async () => {
        await proposeAndWrite(opened, context, 'billing forbid', { args: [change.from, change.to], options: change.model === undefined ? {} : { model: change.model } });
      });
    });
    if (acted === undefined) return;
  }
};

type Job = (typeof ROLE_ROWS)[number]['job'];

const sessionModelChoice = (opened: Opened, context: ModelsFlowContext, job: Job): Promise<ModelsEditResult | undefined> =>
  job === 'classifier' ? proposeAndWrite(opened, context, 'role set', { args: [job, INHERITED_CLASSIFIER], options: {} }) : proposeAndWrite(opened, context, 'role clear', { args: [job], options: {} });

export const chooseRoleModel = async (context: ModelsFlowContext, opened: Opened, job: Job, label: string): Promise<boolean> => {
  const { edit } = opened;
  const canons = canonsOf(edit, job);
  const acted = await chosenThen(context, { title: label, rows: [...canons.map((canon) => ({ label: displayIn(edit, canon) })), { label: SESSION_MODEL_ROW }] }, async (index) => {
    const canon = canons[index];
    const written = canon === undefined ? await sessionModelChoice(opened, context, job) : await proposeAndWrite(opened, context, 'role set', { args: [job, canon], options: {} });
    return written !== undefined;
  });
  return acted?.value === true;
};

export const runRoleFlow = async (context: ModelsFlowContext): Promise<void> => {
  for (;;) {
    const opened = await openEdit(context);
    const acted = await chosenThen(context, { title: ROLE_TITLE, rows: [...roleRows(opened.edit), memoryReviewRow(opened.edit)].map((label) => ({ label })) }, async (index) => {
      const row = ROLE_ROWS[index];
      if (row !== undefined) await chooseRoleModel(context, opened, row.job, row.label);
      else await runMemoryReviewModelFlow(context, opened);
    });
    if (acted === undefined) return;
  }
};

export const runClassifierFlow = async (context: ModelsFlowContext): Promise<boolean> => {
  const row = ROLE_ROWS.find((candidate) => candidate.job === 'classifier');
  if (row === undefined) throw new TypeError('the roles hold no classifier row');
  return chooseRoleModel(context, await openEdit(context), row.job, row.label);
};

export const memoryReviewStateOf = (edit: ModelsEdit): MemoryAutoReviewState => {
  const memory = edit.document['memory'];
  const model = isRecord(memory) ? memory['autoReviewModel'] : undefined;
  return { on: isRecord(memory) && memory['autoReview'] === true, model: edit.resolved.memoryReviewModel ?? (typeof model === 'string' ? model : undefined) };
};

export const sessionModelOf = (model: string | undefined): string | undefined => (model === '' ? undefined : model);

const memoryReviewRow = (edit: ModelsEdit): string => {
  const { model } = memoryReviewStateOf(edit);
  return `${MEMORY_REVIEW_ROW}${SEPARATOR}${model === undefined ? NOT_SET : displayIn(edit, model)}`;
};

const chooseMemoryReviewModel = async (context: ModelsFlowContext, { edit }: Opened): Promise<string | undefined> => {
  const canons = canonsOf(edit);
  const { model } = memoryReviewStateOf(edit);
  const index = await chosenOf(context, { title: MEMORY_REVIEW_MODEL_TITLE, rows: canons.map((canon) => ({ label: displayIn(edit, canon) })), initial: Math.max(0, canons.findIndex((canon) => canon === model)) });
  return index === undefined ? undefined : canons[index];
};

export type MemoryReviewSave = <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export const savingIn =
  (context: ModelsFlowContext): MemoryReviewSave =>
  (work) =>
    context.wait(SAVING_PHASE, work);

const writeMemoryReviewModel = ({ host }: Opened, model: string, signal: AbortSignal): Promise<ModelsEditResult> => editModelsSettings(host.home, host.settingsFile, [{ kind: 'setMemoryReviewModel', model }], { lock: host.lock(), signal });

const writeMemoryReviewSwitch = ({ host }: Opened, value: boolean, signal: AbortSignal): Promise<void> => writeMemoryAutoReview(host.home, host.settingsFile, value, { lock: host.lock(), signal });

export const runMemoryReviewModelFlow = async (context: ModelsFlowContext, opened: Opened): Promise<void> => {
  const model = await chooseMemoryReviewModel(context, opened);
  if (model === undefined) return;
  const written = await refusedSentence(context, () => savingIn(context)((signal) => writeMemoryReviewModel(opened, model, signal)));
  if (written !== undefined) context.info(written.value.summaries.join('\n'));
};

export const setMemoryAutoReview = async (context: ModelsFlowContext, save: MemoryReviewSave, opened: Opened, on: boolean): Promise<MemoryAutoReviewState | undefined> => {
  const current = memoryReviewStateOf(opened.edit).model;
  if (!on) {
    await save((signal) => writeMemoryReviewSwitch(opened, false, signal));
    return { on, model: current };
  }
  const model = current ?? sessionModelOf(context.model) ?? (await chooseMemoryReviewModel(context, opened));
  if (model === undefined) return undefined;
  const written = await refusedSentence(context, () =>
    save(async (signal) => {
      if (current === undefined) await writeMemoryReviewModel(opened, model, signal);
      await writeMemoryReviewSwitch(opened, true, signal);
    }),
  );
  return written === undefined ? undefined : { on, model };
};

const WHOLE_MINUTES = /^[1-9]\d*$/;

export const runTimeoutsFlow = async (context: ModelsFlowContext): Promise<void> => {
  for (;;) {
    const opened = await openEdit(context);
    const { resolved } = opened.edit;
    const rows = [{ label: headersWaitRow(durationText(resolved.headersTimeoutMs)) }, { label: idleWaitRow(durationText(resolved.idleTimeoutMs)) }];
    const acted = await chosenThen(context, { title: TIMEOUTS_TITLE, rows }, async (index) => {
      const minutes = await context.overlays.promptText({ title: MINUTES_PROMPT, validate: (text) => (WHOLE_MINUTES.test(text.trim()) ? undefined : MINUTES_PROBLEM) });
      if (minutes === undefined) return;
      await proposeAndWrite(opened, context, 'timeouts', { args: [], options: { [index === 0 ? 'headers' : 'idle']: minutes.trim() } });
    });
    if (acted === undefined) return;
  }
};
