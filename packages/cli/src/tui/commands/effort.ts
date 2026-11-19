import { editModelsSettings } from '@momonga/config';
import { REASONING_EFFORTS, isReasoningEffort } from '@momonga/protocol';
import type { MomongaModelEntry, ReasoningEffort } from '@momonga/protocol';
import { acceptedEffortsOf, declaredReasoning, effortLine, effortRefusalText, sentEffort, shownEffort } from '../effort.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';
import type { TuiBackend } from '../backend.ts';

export const EFFORT_PICKER_TITLE = 'Reasoning effort';
export const SESSION_FLAG = '--session';
export const RESET_WORD = 'reset';
export const SESSION_ONLY_LABEL = 'this session only';
export const IN_FORCE_MARK = 'in use';
export const SAVING_EFFORT = 'saving the effort';

export type EffortScope = 'saved' | 'session';

const SCOPE_TEXTS: Readonly<Record<EffortScope, string>> = { saved: 'saved', session: 'this session only' };

export const effortAnswerText = (level: ReasoningEffort, modelName: string, scope: EffortScope): string => `effort: ${level} for ${modelName}; ${SCOPE_TEXTS[scope]}`;

export const unknownEffortText = (word: string, modelName: string, accepted: readonly ReasoningEffort[]): string => `unknown effort ${word} for ${modelName}; available: ${accepted.join(', ')}`;

export const writeModelEffort = async (context: { readonly backend: Pick<TuiBackend, 'modelsHost'>; info(text: string): void; wait<T>(phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> }, model: string, level: ReasoningEffort | undefined): Promise<void> => {
  const host = context.backend.modelsHost(new AbortController().signal, context.info);
  await context.wait(SAVING_EFFORT, (signal) => editModelsSettings(host.home, host.settingsFile, [{ kind: 'setModelField', model, path: ['effort'], value: level }], { lock: host.lock(), signal }));
};

export const applyEffort = async (context: SlashContext, model: string, level: ReasoningEffort, scope: EffortScope): Promise<void> => {
  if (scope === 'saved') await writeModelEffort(context, model, level);
  await context.setEffort(level);
  context.info(effortAnswerText(level, context.shownModel(model), scope));
};

const resetEffort = async (context: SlashContext, model: string): Promise<void> => {
  await writeModelEffort(context, model, undefined);
  await context.setEffort(null);
  const shown = shownEffort(await context.backend.models(), model, undefined);
  const name = context.shownModel(model);
  context.info(`${shown === undefined ? 'effort' : effortLine(shown, 'short')} for ${name}; the level saved for it is removed`);
};

const typedOf = (args: string): { words: string[]; session: boolean } => {
  const all = args.split(/\s+/).filter((word) => word !== '');
  return { words: all.filter((word) => word !== SESSION_FLAG), session: all.includes(SESSION_FLAG) };
};

const levelsOf = (entries: readonly MomongaModelEntry[], model: string, context: SlashContext): ReasoningEffort[] | undefined => {
  const declared = declaredReasoning(entries, model);
  const name = context.shownModel(model);
  if (!declared.known) {
    context.info(`the capabilities of ${name} are not known yet, so its reasoning efforts are not known; use /effort again when it is ready`);
    return undefined;
  }
  const accepted = acceptedEffortsOf(declared);
  if (accepted.length === 0) {
    context.info(effortRefusalText(name));
    return undefined;
  }
  return accepted;
};

export const effortCommand: SlashCommand = {
  name: 'effort',
  description: 'choose the reasoning effort of the model, saved for it or for this session only; reset removes the saved one',
  usage: `[${REASONING_EFFORTS.join('|')}] [${SESSION_FLAG}] | ${RESET_WORD}`,
  run: async (args, context) => {
    const model = context.model;
    if (model === undefined) throw new Error('/effort ran without a session model');
    const typed = typedOf(args);
    if (typed.words.length === 1 && typed.words[0] === RESET_WORD && !typed.session) {
      await resetEffort(context, model);
      return;
    }
    const entries = await context.backend.models();
    const accepted = levelsOf(entries, model, context);
    if (accepted === undefined) return;
    if (typed.words.length > 0) {
      const [word] = typed.words;
      if (typed.words.length > 1 || !isReasoningEffort(word) || !accepted.includes(word)) {
        context.info(unknownEffortText(typed.words.join(' '), context.shownModel(model), accepted));
        return;
      }
      await applyEffort(context, model, word, typed.session ? 'session' : 'saved');
      return;
    }
    const inForce = sentEffort(entries, model, context.effort);
    const choice = await context.overlays.choose({
      title: EFFORT_PICKER_TITLE,
      rows: accepted.map((level) => ({ label: level, ...(level === inForce ? { value: IN_FORCE_MARK } : {}) })),
      initial: inForce === undefined ? 0 : Math.max(0, accepted.indexOf(inForce)),
      decideOn: 'enter',
      escape: 'back',
      filter: false,
      alt: { label: SESSION_ONLY_LABEL },
    });
    const chosen = choice === undefined ? undefined : accepted[choice.index];
    if (choice === undefined || chosen === undefined) return;
    await applyEffort(context, model, chosen, choice.alt ? 'session' : 'saved');
  },
};
