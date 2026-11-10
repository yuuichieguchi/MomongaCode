import { OUTPUT_RESERVE, ceilRatio, marginFloorFor } from '@momonga/protocol';
import type { ChainRoomFacts } from '@momonga/protocol';

export type ChainMember = { model: string; facts: ChainRoomFacts; measuring: boolean };

export type RoomRefusal =
  | { kind: 'unknown_room'; first: string; unbounded: string; other: string }
  | { kind: 'small_room'; first: string; unboundedOutputTokens: number; minWindow: number; margin: number; room: number; required: number };

export type RoomVerdict = { kind: 'serve' } | { kind: 'wait' } | { kind: 'refuse'; refusal: RoomRefusal };

const SERVE: RoomVerdict = { kind: 'serve' };

type KnownFacts = ChainRoomFacts & { contextWindow: number; maxOutputTokens: number };

const knownFactsOf = (member: ChainMember): KnownFacts | undefined => {
  const { contextWindow, maxOutputTokens } = member.facts;
  return contextWindow === undefined || maxOutputTokens === undefined ? undefined : { ...member.facts, contextWindow, maxOutputTokens };
};

export const chainRoomVerdict = (first: string, members: readonly ChainMember[]): RoomVerdict => {
  const unbounded = members.find((member) => !member.facts.outputBounded);
  if (unbounded === undefined) return SERVE;
  const missing = members.filter((member) => knownFactsOf(member) === undefined);
  if (missing.length > 0 && members.length === 1) return SERVE;
  const unmeasurable = missing.find((member) => !member.measuring);
  if (unmeasurable !== undefined) return { kind: 'refuse', refusal: { kind: 'unknown_room', first, unbounded: unbounded.model, other: unmeasurable.model } };
  if (missing.length > 0) return { kind: 'wait' };
  const known = members.flatMap((member) => knownFactsOf(member) ?? []);
  const minWindow = Math.min(...known.map((facts) => facts.contextWindow));
  const unboundedOutputTokens = Math.max(...known.map((facts) => facts.maxOutputTokens));
  const margin = marginFloorFor(minWindow);
  const required = ceilRatio(OUTPUT_RESERVE, minWindow);
  const room = minWindow - unboundedOutputTokens - margin;
  return room < required ? { kind: 'refuse', refusal: { kind: 'small_room', first, unboundedOutputTokens, minWindow, margin, room, required } } : SERVE;
};

export const roomVerdictText = (refusal: RoomRefusal, displayOf: (canon: string) => string): string => {
  const first = displayOf(refusal.first);
  if (refusal.kind === 'unknown_room') {
    return `${first}: ${displayOf(refusal.unbounded)} has no output bound, and ${displayOf(refusal.other)} neither declares nor reports a contextWindow or maxOutputTokens, so the input room of ${first} and the models it falls back to cannot be known`;
  }
  return `${first} and the models it falls back to include a model that carries no output bound (outputBoundField none), so any of them can emit up to ${refusal.unboundedOutputTokens} tokens; with the smallest context window ${refusal.minWindow} only ${refusal.room} tokens of input remain, below the ${refusal.required} required`;
};

export const roomNumbersText = (refusal: Extract<RoomRefusal, { kind: 'small_room' }>): string =>
  `up to ${refusal.unboundedOutputTokens} output tokens, smallest context window ${refusal.minWindow}, margin ${refusal.margin}, ${refusal.room} left for input, ${refusal.required} required`;
