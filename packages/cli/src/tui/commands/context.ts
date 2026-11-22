import { DEFAULT_CONTEXT_IMPROVE_CANDIDATES, MAX_DATASET_SEED } from '@momonga/eval';
import { bundledContextDatasetSummary, contextImprovePlanLines } from '../../commands/context.ts';
import { commandWords } from '../command-words.ts';
import { NEEDS_SESSION_NOTE } from '../slash.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';
import { runShellArgv, shellFormOf } from './shell-commands.ts';

export const CONTEXT_IMPROVE_CONFIRM_TITLE = 'Start context improve?';
const CONFIRM_ROWS = ['Start', 'Cancel'] as const;
const DEFAULT_OUTCOME_LABEL = 'auto (~/.momonga/state/context-outcomes/...)';

type ParsedImproveFlags =
  | { kind: 'passthrough' }
  | {
      kind: 'ok';
      dataset?: string;
      model?: string;
      candidates?: number;
      tokenCap?: number;
      outcome?: string;
      yes: boolean;
    };

const parsePositiveInt = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
};

const parseSeedInt = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= MAX_DATASET_SEED ? value : undefined;
};

const optionValueOf = (words: readonly string[], index: number): { flag: string; value: string | undefined; consumed: number } => {
  const word = words[index] ?? '';
  const eq = word.indexOf('=');
  if (eq > 0) return { flag: word.slice(0, eq), value: word.slice(eq + 1), consumed: 1 };
  return { flag: word, value: words[index + 1], consumed: 2 };
};

const parseImproveFlags = (words: readonly string[]): ParsedImproveFlags => {
  let dataset: string | undefined;
  let model: string | undefined;
  let candidates: number | undefined;
  let tokenCap: number | undefined;
  let outcome: string | undefined;
  let yes = false;
  for (let index = 0; index < words.length; ) {
    const word = words[index] ?? '';
    if (word === '-h' || word === '--help') return { kind: 'passthrough' };
    if (word === '--yes') {
      yes = true;
      index += 1;
      continue;
    }
    const { flag, value, consumed } = optionValueOf(words, index);
    if (value === undefined) return { kind: 'passthrough' };
    if (flag === '--dataset') {
      dataset = value;
      index += consumed;
      continue;
    }
    if (flag === '--model') {
      model = value;
      index += consumed;
      continue;
    }
    if (flag === '--outcome') {
      outcome = value;
      index += consumed;
      continue;
    }
    if (flag === '--seed') {
      if (parseSeedInt(value) === undefined) return { kind: 'passthrough' };
      index += consumed;
      continue;
    }
    if (flag === '--candidates') {
      const parsed = parsePositiveInt(value);
      if (parsed === undefined) return { kind: 'passthrough' };
      candidates = parsed;
      index += consumed;
      continue;
    }
    if (flag === '--token-cap') {
      const parsed = parsePositiveInt(value);
      if (parsed === undefined) return { kind: 'passthrough' };
      tokenCap = parsed;
      index += consumed;
      continue;
    }
    return { kind: 'passthrough' };
  }
  return {
    kind: 'ok',
    ...(dataset === undefined ? {} : { dataset }),
    ...(model === undefined ? {} : { model }),
    ...(candidates === undefined ? {} : { candidates }),
    ...(tokenCap === undefined ? {} : { tokenCap }),
    ...(outcome === undefined ? {} : { outcome }),
    yes,
  };
};

const runContextImproveInTui = async (words: readonly string[], rawArgs: string, context: SlashContext): Promise<void> => {
  const parsed = parseImproveFlags(words.slice(1));
  if (parsed.kind === 'passthrough') {
    await shellForm.run(rawArgs, context);
    return;
  }
  const effectiveModel = parsed.model ?? context.model;
  if (effectiveModel === undefined) {
    context.info(NEEDS_SESSION_NOTE);
    return;
  }
  const effectiveCandidates = parsed.candidates ?? (parsed.tokenCap === undefined ? DEFAULT_CONTEXT_IMPROVE_CANDIDATES : undefined);
  if (!parsed.yes) {
    const shownModel = parsed.model ?? context.shownModel(effectiveModel);
    const lines = contextImprovePlanLines({
      model: shownModel,
      dataset: parsed.dataset ?? bundledContextDatasetSummary(),
      ...(effectiveCandidates === undefined ? {} : { candidates: effectiveCandidates }),
      ...(parsed.tokenCap === undefined ? {} : { tokenCap: parsed.tokenCap }),
      outcome: parsed.outcome ?? DEFAULT_OUTCOME_LABEL,
    });
    const choice = await context.overlays.choose({
      title: CONTEXT_IMPROVE_CONFIRM_TITLE,
      lines,
      rows: CONFIRM_ROWS.map((label) => ({ label })),
      initial: CONFIRM_ROWS.indexOf('Cancel'),
      decideOn: 'enter',
      escape: CONFIRM_ROWS.indexOf('Cancel'),
      filter: false,
    });
    if (choice?.index !== CONFIRM_ROWS.indexOf('Start')) {
      context.info('context improve cancelled');
      return;
    }
    context.overlays.closeScreen();
  }
  const argv: string[] = ['context', ...words];
  if (parsed.model === undefined) argv.push('--model', effectiveModel);
  if (!parsed.yes) argv.push('--yes');
  runShellArgv('context', argv, context);
};

const shellForm = shellFormOf('context');

export const contextCommand: SlashCommand = {
  name: shellForm.name,
  ...(shellForm.usage === undefined ? {} : { usage: shellForm.usage }),
  description: shellForm.description,
  ...(shellForm.subcommands === undefined ? {} : { subcommands: shellForm.subcommands }),
  needsSession: false,
  run: async (args, context) => {
    const parsed = commandWords(args);
    if (parsed.kind === 'words' && parsed.words[0] === 'improve') {
      await runContextImproveInTui(parsed.words, args, context);
      return;
    }
    await shellForm.run(args, context);
  },
};
