import { loadUserSettings, writeOutputStyleSetting } from '@momonga/config';
import { DEFAULT_OUTPUT_STYLE, OUTPUT_STYLES, isOutputStyle } from '@momonga/protocol';
import type { OutputStyle } from '@momonga/protocol';
import type { SlashCommand, SlashContext } from '../slash.ts';
import type { TuiBackend } from '../backend.ts';
import type { OverlayPorts } from '../picker.tsx';

export const STYLE_PICKER_TITLE = 'Output style';
export const STYLE_SESSION_FLAG = '--session';
export const STYLE_RESET_WORD = 'reset';
export const STYLE_SESSION_ONLY_LABEL = 'this session only';
export const STYLE_IN_FORCE_MARK = 'in use';
export const SAVING_STYLE = 'saving the output style';

export type StyleScope = 'saved' | 'session';

const SCOPE_TEXTS: Readonly<Record<StyleScope, string>> = { saved: 'saved', session: 'this session only' };

const STYLE_DESCRIPTIONS: Readonly<Record<OutputStyle, string>> = {
  standard: 'concise summary of changes, verification, remaining work, and decisions',
  concise: 'outcome and user decisions only, minimal tokens',
  explanatory: 'standard summary plus rationale, trade-offs, and short term definitions',
};

export const styleAnswerText = (style: OutputStyle, scope: StyleScope): string => `style: ${style}; ${SCOPE_TEXTS[scope]}`;

export const unknownStyleText = (word: string): string => `unknown style ${word}; available: ${OUTPUT_STYLES.join(', ')}`;

export const writeOutputStyle = async (
  context: { readonly backend: Pick<TuiBackend, 'modelsHost'>; info(text: string): void; wait<T>(phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> },
  style: OutputStyle | undefined,
): Promise<void> => {
  const host = context.backend.modelsHost(new AbortController().signal, context.info);
  await context.wait(SAVING_STYLE, (signal) => writeOutputStyleSetting(host.home, host.settingsFile, style, { lock: host.lock(), signal }));
};

export type StyleContext = Pick<SlashContext, 'outputStyle' | 'setOutputStyle' | 'info' | 'wait'> & {
  readonly backend: Pick<TuiBackend, 'modelsHost'>;
  readonly overlays: Pick<OverlayPorts, 'choose'> & Partial<Pick<OverlayPorts, 'closeScreen'>>;
};

export const applyStyle = async (context: StyleContext, style: OutputStyle, scope: StyleScope): Promise<void> => {
  context.overlays.closeScreen?.();
  if (scope === 'saved') await writeOutputStyle(context, style);
  await context.setOutputStyle?.(style);
  context.info(styleAnswerText(style, scope));
};

const resetStyle = async (context: StyleContext): Promise<void> => {
  await writeOutputStyle(context, undefined);
  await context.setOutputStyle?.(null);
  context.info(`style: ${DEFAULT_OUTPUT_STYLE}; the saved output style is removed`);
};

const typedOf = (args: string): { words: string[]; session: boolean } => {
  const all = args.split(/\s+/).filter((word) => word !== '');
  return { words: all.filter((word) => word !== STYLE_SESSION_FLAG), session: all.includes(STYLE_SESSION_FLAG) };
};

export type ChosenStyle = { readonly style: OutputStyle; readonly scope: StyleScope };

export const chooseStyle = async (overlays: Pick<OverlayPorts, 'choose'>, inForce: OutputStyle): Promise<ChosenStyle | undefined> => {
  const choice = await overlays.choose({
    title: STYLE_PICKER_TITLE,
    rows: OUTPUT_STYLES.map((style) => ({ label: style, ...(style === inForce ? { value: STYLE_IN_FORCE_MARK } : {}) })),
    initial: Math.max(0, OUTPUT_STYLES.indexOf(inForce)),
    decideOn: 'enter',
    escape: 'back',
    filter: false,
    alt: { label: STYLE_SESSION_ONLY_LABEL },
  });
  const style = choice === undefined ? undefined : OUTPUT_STYLES[choice.index];
  if (choice === undefined || style === undefined) return undefined;
  return { style, scope: choice.alt ? 'session' : 'saved' };
};

const savedOutputStyleOf = async (home: string, signal: AbortSignal): Promise<OutputStyle | undefined> => {
  try {
    const loaded = await loadUserSettings({ home, env: {}, signal });
    const style = loaded.settings.output?.style;
    return isOutputStyle(style) ? style : undefined;
  } catch {
    return undefined;
  }
};

export const styleCommand: SlashCommand = {
  name: 'style',
  description: 'choose the output style (standard, concise, or explanatory), saved or for this session only; reset restores standard',
  usage: `[${OUTPUT_STYLES.join('|')}] [${STYLE_SESSION_FLAG}] | ${STYLE_RESET_WORD}`,
  subcommands: [
    ...OUTPUT_STYLES.map((style) => ({ name: style, description: STYLE_DESCRIPTIONS[style] })),
    { name: STYLE_RESET_WORD, description: 'remove the saved output style and restore standard' },
  ],
  run: async (args, context) => {
    const typed = typedOf(args);
    if (typed.words.length === 1 && typed.words[0] === STYLE_RESET_WORD && !typed.session) {
      await resetStyle(context);
      return;
    }
    if (typed.words.length > 0) {
      const [word] = typed.words;
      if (typed.words.length > 1 || !isOutputStyle(word)) {
        context.info(unknownStyleText(typed.words.join(' ')));
        return;
      }
      await applyStyle(context, word, typed.session ? 'session' : 'saved');
      return;
    }
    const signal = new AbortController().signal;
    const inForce =
      context.outputStyle ??
      (await savedOutputStyleOf(context.backend.modelsHost(signal, context.info).home, signal)) ??
      DEFAULT_OUTPUT_STYLE;
    const chosen = await chooseStyle(context.overlays, inForce);
    if (chosen === undefined) return;
    await applyStyle(context, chosen.style, chosen.scope);
  },
};
