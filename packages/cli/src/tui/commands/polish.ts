import { buildPolishPrompt, DEFAULT_POLISH_AUDIENCE } from '@momonga/protocol';
import type { SlashCommand, SlashContext } from '../slash.ts';

export const NOTHING_TO_POLISH = 'Nothing to polish: wait for an assistant response or pass a file path (/polish <file>).';

export type ParsedPolishArgs =
  | { readonly ok: true; readonly filePath?: string; readonly audience?: string }
  | { readonly ok: false; readonly message: string };

const tokenizeArgs = (input: string): string[] | undefined => {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote !== undefined) return undefined;
  if (current.length > 0) tokens.push(current);
  return tokens;
};

export const parsePolishArgs = (args: string): ParsedPolishArgs => {
  const tokens = tokenizeArgs(args.trim());
  if (tokens === undefined) return { ok: false, message: 'unclosed quote in /polish arguments' };

  let audience: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '--audience') {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, message: '--audience requires a value (e.g. /polish --audience "非エンジニア")' };
      }
      audience = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--audience=')) {
      const value = token.slice('--audience='.length).trim();
      if (value === '') return { ok: false, message: '--audience requires a non-empty value' };
      audience = value;
      continue;
    }
    if (token.startsWith('--')) {
      return { ok: false, message: `unknown option ${token}; usage: /polish [<file>] [--audience <reader>]` };
    }
    positional.push(token);
  }

  if (positional.length > 1) {
    return { ok: false, message: 'too many arguments; pass at most one file path (/polish [<file>] [--audience <reader>])' };
  }

  return {
    ok: true,
    ...(positional[0] === undefined ? {} : { filePath: positional[0] }),
    ...(audience === undefined ? {} : { audience }),
  };
};

export type PolishFileCheck = (filePath: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;

export const createPolishCommand = (checkFile?: PolishFileCheck): SlashCommand => ({
  name: 'polish',
  description: `run bounded clarity and codebase-factuality revision on the last answer or a file (default audience: ${DEFAULT_POLISH_AUDIENCE})`,
  usage: '[<file>] [--audience <reader>]',
  run: async (args, context: SlashContext) => {
    const parsed = parsePolishArgs(args);
    if (!parsed.ok) {
      context.info(parsed.message);
      return;
    }

    if (parsed.filePath !== undefined) {
      const verifier = checkFile ?? (context.backend?.checkReadableFile === undefined ? undefined : (p: string) => context.backend.checkReadableFile!(p));
      if (verifier !== undefined) {
        const check = await verifier(parsed.filePath);
        if (!check.ok) {
          context.info(check.message);
          return;
        }
      }
      await context.startRun(
        buildPolishPrompt({
          target: { kind: 'file', path: parsed.filePath },
          ...(parsed.audience === undefined ? {} : { audience: parsed.audience }),
        }),
      );
      return;
    }

    const last = context.clipboard.lastAnswer();
    if (last === undefined || last.trim() === '') {
      context.info(NOTHING_TO_POLISH);
      return;
    }

    await context.startRun(
      buildPolishPrompt({
        target: { kind: 'answer', text: last },
        ...(parsed.audience === undefined ? {} : { audience: parsed.audience }),
      }),
    );
  },
});

export const polishCommand: SlashCommand = createPolishCommand();
