import { MIN_ROOM_TOKENS, PinnedOverflowError } from '@momonga/context';
import type { ClaimContext } from './claim-context.ts';
import { measureToolsWith, rememberAdmittedTools } from './context-step.ts';

export type ToolAdmission = { admitted: true } | { admitted: false; reason: string };

export type ToolLoading = {
  catalog(): readonly string[];
  isLoaded(name: string): boolean;
  admit(names: readonly string[]): Promise<ToolAdmission>;
};

const refusalOf = (names: readonly string[], tokens: number, ceiling: number): string =>
  `${names.join(', ')} was not loaded: the pinned context with ${names.length === 1 ? 'its definition' : 'their definitions'} would take ${tokens} tokens, but at most ${ceiling} fit and at least ${MIN_ROOM_TOKENS} must stay free for the conversation. Continue without it.`;

const settled = (): undefined => undefined;

export const createToolLoading = (contextOf: () => ClaimContext): ToolLoading => {
  const granted: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  const loadedNow = (ctx: ClaimContext): string[] => [...new Set([...ctx.journal.state.loadedTools, ...granted])];

  const check = async (names: readonly string[]): Promise<ToolAdmission> => {
    const ctx = contextOf();
    const after = ctx.toolOffer([...loadedNow(ctx), ...names]);
    try {
      const { measure, floorTokens, kept } = await measureToolsWith(ctx, after.tools);
      if (after.tools.some((tool) => !kept.includes(tool.name))) return { admitted: false, reason: refusalOf(names, floorTokens, measure.ceiling) };
      granted.push(...names);
      rememberAdmittedTools(ctx, after.tools, measure.pinnedTokens);
      return { admitted: true };
    } catch (error) {
      if (error instanceof PinnedOverflowError) return { admitted: false, reason: refusalOf(names, error.pinnedTokens, error.ceiling) };
      throw error;
    }
  };

  return {
    catalog: () => contextOf().toolOffer(loadedNow(contextOf())).catalog,
    isLoaded: (name) => loadedNow(contextOf()).includes(name),
    admit: (names) => {
      const result = queue.then(() => check(names));
      queue = result.then(settled, settled);
      return result;
    },
  };
};
