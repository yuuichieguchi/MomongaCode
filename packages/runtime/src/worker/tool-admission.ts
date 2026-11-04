import { MIN_ROOM_TOKENS, PinnedOverflowError } from '@momonga/context';
import type { ClaimContext } from './claim-context.ts';
import { measureToolsWith, rememberAdmittedTools } from './context-step.ts';

export type ToolAdmission = { admitted: true } | { admitted: false; reason: string };

export type ToolLoading = {
  catalog(): readonly string[];
  isLoaded(name: string): boolean;
  isClaimed(name: string): boolean;
  claim(names: readonly string[]): void;
  release(names: readonly string[]): void;
  admit(names: readonly string[]): Promise<ToolAdmission>;
  rememberLoaded(names: readonly string[]): void;
};

type Batch = { step: number; claimed: Set<string>; granted: string[]; pinnedTokens: Map<string, number> };

const keyOf = (names: readonly string[]): string => [...names].sort().join('\n');

const refusalOf = (names: readonly string[], tokens: number, ceiling: number): string =>
  `${names.join(', ')} was not loaded: the pinned context with ${names.length === 1 ? 'its definition' : 'their definitions'} would take ${tokens} tokens, but at most ${ceiling} fit and at least ${MIN_ROOM_TOKENS} must stay free for the conversation. Continue without it.`;

const settled = (): undefined => undefined;

export const createToolLoading = (contextOf: () => ClaimContext): ToolLoading => {
  let batch: Batch = { step: -1, claimed: new Set(), granted: [], pinnedTokens: new Map() };
  let queue: Promise<unknown> = Promise.resolve();

  const batchOf = (ctx: ClaimContext): Batch => {
    if (batch.step !== ctx.journal.state.step) batch = { step: ctx.journal.state.step, claimed: new Set(), granted: [], pinnedTokens: new Map() };
    return batch;
  };

  const loadedNow = (ctx: ClaimContext): string[] => [...new Set([...ctx.journal.state.loadedTools, ...batchOf(ctx).granted])];

  const check = async (names: readonly string[]): Promise<ToolAdmission> => {
    const ctx = contextOf();
    const current = batchOf(ctx);
    const after = ctx.toolOffer([...loadedNow(ctx), ...names]);
    try {
      const { measure, floorTokens, kept } = await measureToolsWith(ctx, after.tools);
      if (after.tools.some((tool) => !kept.includes(tool.name))) return { admitted: false, reason: refusalOf(names, floorTokens, measure.ceiling) };
      current.granted.push(...names);
      current.pinnedTokens.set(keyOf(names), measure.pinnedTokens);
      return { admitted: true };
    } catch (error) {
      if (error instanceof PinnedOverflowError) return { admitted: false, reason: refusalOf(names, error.pinnedTokens, error.ceiling) };
      throw error;
    }
  };

  return {
    catalog: () => contextOf().toolOffer(loadedNow(contextOf())).catalog,
    isLoaded: (name) => contextOf().journal.state.loadedTools.includes(name),
    isClaimed: (name) => batchOf(contextOf()).claimed.has(name),
    claim: (names) => {
      const { claimed } = batchOf(contextOf());
      for (const name of names) claimed.add(name);
    },
    release: (names) => {
      const { claimed } = batchOf(contextOf());
      for (const name of names) claimed.delete(name);
    },
    admit: (names) => {
      const result = queue.then(() => check(names));
      queue = result.then(settled, settled);
      return result;
    },
    rememberLoaded: (names) => {
      const ctx = contextOf();
      const pinnedTokens = batchOf(ctx).pinnedTokens.get(keyOf(names));
      if (pinnedTokens === undefined) throw new Error(`tools ${names.join(', ')} were journaled as loaded without an admission in this batch`);
      rememberAdmittedTools(ctx, ctx.toolOffer(ctx.journal.state.loadedTools).tools, pinnedTokens);
    },
  };
};
