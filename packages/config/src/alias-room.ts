import { OUTPUT_RESERVE, ceilRatio, marginFloorFor } from '@momonga/protocol';

export type AliasMember = {
  target: string;
  outputBounded: boolean;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  measuring: boolean;
};

export type AliasRoomVerdict = { kind: 'serve' } | { kind: 'wait' } | { kind: 'refuse'; message: string };

const SERVE: AliasRoomVerdict = { kind: 'serve' };

const unknownRoomText = (alias: string, unbounded: string, other: string): string =>
  `models.aliases.${alias}: target "${unbounded}" has no output bound, and the target "${other}" neither declares nor reports a contextWindow or maxOutputTokens, so the input room of the alias cannot be checked; declare them or remove one of the targets`;

const smallRoomText = (alias: string, unboundedOutputTokens: number, minWindow: number, margin: number, room: number, required: number): string =>
  `models.aliases.${alias} holds a target that carries no output bound (outputBoundField none), so any member can emit up to ${unboundedOutputTokens} tokens; with the smallest context window ${minWindow} and a margin of ${margin}, ${room} tokens are left for input, which is below the ${required} (a quarter of the window) that input needs`;

const hasValues = (member: AliasMember): member is AliasMember & { contextWindow: number; maxOutputTokens: number } =>
  member.contextWindow !== undefined && member.maxOutputTokens !== undefined;

export const aliasRoomVerdict = (alias: string, members: readonly AliasMember[]): AliasRoomVerdict => {
  const unbounded = members.find((member) => !member.outputBounded);
  if (unbounded === undefined) return SERVE;
  const missing = members.filter((member) => !hasValues(member));
  if (missing.length > 0 && members.length === 1) return SERVE;
  const unmeasurable = missing.find((member) => !member.measuring);
  if (unmeasurable !== undefined) return { kind: 'refuse', message: unknownRoomText(alias, unbounded.target, unmeasurable.target) };
  if (missing.length > 0) return { kind: 'wait' };
  const known = members.filter(hasValues);
  const minWindow = Math.min(...known.map((member) => member.contextWindow));
  const unboundedOutputTokens = Math.max(...known.map((member) => member.maxOutputTokens));
  const margin = marginFloorFor(minWindow);
  const required = ceilRatio(OUTPUT_RESERVE, minWindow);
  const room = minWindow - unboundedOutputTokens - margin;
  return room < required ? { kind: 'refuse', message: smallRoomText(alias, unboundedOutputTokens, minWindow, margin, room, required) } : SERVE;
};
