import { editModelsSettings } from '@momonga/config';
import type { ModelsEditResult } from '@momonga/config';
import type { DetectedLocalServer } from '@momonga/protocol';
import { isModelsRefusal, modelsEditOf, plannedOf, proposeForm } from '../../commands/models.ts';
import type { FormInput, ModelsEdit, ModelsForm, ModelsHost, ModelsProposal } from '../../commands/models.ts';
import type { TuiBackend } from '../backend.ts';
import type { OverlayPorts, PickRequest } from '../picker.tsx';
import { SAVING_PHASE } from './texts.ts';

export type FoundServers = { servers(): readonly DetectedLocalServer[]; remember(servers: readonly DetectedLocalServer[]): void };

export const createFoundServers = (): FoundServers => {
  let found: readonly DetectedLocalServer[] = [];
  return {
    servers: () => found,
    remember: (servers) => {
      found = servers;
    },
  };
};

export type ModelsFlowContext = {
  readonly backend: Pick<TuiBackend, 'modelList' | 'modelsHost' | 'storeSecret' | 'health' | 'plan'>;
  readonly overlays: Pick<OverlayPorts, 'choose' | 'promptText'>;
  readonly found: FoundServers;
  readonly model: string | undefined;
  info(text: string): void;
  wait<T>(phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
};

export const CONFIRM_ROWS = ['No', 'Yes'] as const;

const NO = CONFIRM_ROWS.indexOf('No');
const YES = CONFIRM_ROWS.indexOf('Yes');

export const confirmedBy = async (context: ModelsFlowContext, question: string): Promise<boolean> => {
  const choice = await context.overlays.choose({ title: question, rows: CONFIRM_ROWS.map((label) => ({ label })), initial: NO, decideOn: 'enter', escape: NO, filter: false });
  return choice?.index === YES;
};

export const chosenOf = async (context: ModelsFlowContext, request: PickRequest): Promise<number | undefined> =>
  (await context.overlays.choose({ decideOn: 'enter', escape: 'back', filter: false, ...request }))?.index;

export const hostOf = (context: ModelsFlowContext, signal: AbortSignal): ModelsHost => context.backend.modelsHost(signal, context.info);

export const restingHost = (context: ModelsFlowContext): ModelsHost => hostOf(context, new AbortController().signal);

export type Opened = { host: ModelsHost; edit: ModelsEdit };

export const openEdit = async (context: ModelsFlowContext): Promise<Opened> => {
  const host = restingHost(context);
  return { host, edit: await modelsEditOf(host) };
};

export type Cancellable<T> = { readonly value: T } | undefined;

export const cancellable = async <T>(context: ModelsFlowContext, phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<Cancellable<T>> => {
  let cancelled = false;
  try {
    const value = await context.wait(phase, async (signal) => {
      try {
        return await work(signal);
      } catch (error) {
        cancelled = signal.aborted;
        throw error;
      }
    });
    return { value };
  } catch (error) {
    if (cancelled) return undefined;
    throw error;
  }
};

export const refusedSentence = async <T>(context: ModelsFlowContext, work: () => Promise<T>): Promise<Cancellable<T>> => {
  try {
    return { value: await work() };
  } catch (error) {
    if (!isModelsRefusal(error)) throw error;
    context.info(error.message);
    return undefined;
  }
};

export const writeConfirmed = async ({ host }: Opened, context: ModelsFlowContext, proposal: ModelsProposal, before: () => Promise<void> = async () => undefined): Promise<ModelsEditResult | undefined> => {
  const written = await refusedSentence(context, async () => {
    await before();
    return context.wait(SAVING_PHASE, (signal) => editModelsSettings(host.home, host.settingsFile, proposal.operations, { signal }));
  });
  if (written === undefined) return undefined;
  context.info(written.value.summaries.join('\n'));
  return written.value;
};

export const proposeAndWrite = async (opened: Opened, context: ModelsFlowContext, form: ModelsForm, input: FormInput): Promise<ModelsEditResult | undefined> => {
  const proposal = await refusedSentence(context, () => proposeForm(opened.host, opened.edit, form, input));
  return proposal === undefined ? undefined : confirmAndWrite(opened, context, proposal.value);
};

export const confirmAndWrite = async (opened: Opened, context: ModelsFlowContext, proposal: ModelsProposal, before?: () => Promise<void>): Promise<ModelsEditResult | undefined> => {
  const question = await refusedSentence(context, async () => plannedOf(opened.edit, proposal));
  if (question === undefined || !(await confirmedBy(context, question.value))) return undefined;
  return writeConfirmed(opened, context, proposal, before);
};
