import type {
  CompactionBlock,
  CompactionPlan,
  ContextEviction,
  PinnedBreakdown,
  ProtectionLevel,
} from './types.ts';

export class PinnedOverflowError extends Error {
  readonly pinnedTokens: number;
  readonly ceiling: number;
  readonly breakdown: PinnedBreakdown;

  constructor(facts: { pinnedTokens: number; ceiling: number; breakdown: PinnedBreakdown }, message?: string) {
    super(message ?? `pinned context needs ${facts.pinnedTokens} tokens but at most ${facts.ceiling} fit`);
    this.name = 'PinnedOverflowError';
    this.pinnedTokens = facts.pinnedTokens;
    this.ceiling = facts.ceiling;
    this.breakdown = facts.breakdown;
  }
}

export class PinnedRoomError extends PinnedOverflowError {
  readonly room: number;
  readonly minimum: number;

  constructor(facts: { pinnedTokens: number; ceiling: number; breakdown: PinnedBreakdown; room: number; minimum: number }) {
    super(
      facts,
      `pinned context fits (${facts.pinnedTokens} of ${facts.ceiling} tokens) but leaves only ${facts.room} tokens for the conversation; at least ${facts.minimum} are needed`,
    );
    this.name = 'PinnedRoomError';
    this.room = facts.room;
    this.minimum = facts.minimum;
  }
}

export const BOUND_REMEDIATION = 'raise contextWindow, lower maxOutputTokens, or calibrate the token counter';

export type PinnedBoundFacts = {
  pinnedTokens: number;
  ceiling: number;
  breakdown: PinnedBreakdown;
  inputBudget: number;
  boundAtZero: number;
  maxInput: number | undefined;
};

export class PinnedBoundError extends PinnedOverflowError {
  readonly inputBudget: number;
  readonly boundAtZero: number;
  readonly maxInput: number | undefined;

  constructor(facts: PinnedBoundFacts) {
    super(
      facts,
      facts.maxInput === undefined
        ? `no input size fits: the token counter's error bound is ${facts.boundAtZero} tokens even for an empty input, more than the input budget of ${facts.inputBudget}; ${BOUND_REMEDIATION}`
        : `the pinned context needs ${facts.pinnedTokens} tokens, but with the token counter's error bound at most ${facts.maxInput} fit the input budget of ${facts.inputBudget}; ${BOUND_REMEDIATION}`,
    );
    this.name = 'PinnedBoundError';
    this.inputBudget = facts.inputBudget;
    this.boundAtZero = facts.boundAtZero;
    this.maxInput = facts.maxInput;
  }
}

export type ContextOverflowFacts = {
  inputTokens: number;
  inputBudget: number;
  ceiling: number;
  pinnedTokens: number;
  floorTokens: number;
  level: number;
  lastLevel: boolean;
  protection: ProtectionLevel;
  breakdown: PinnedBreakdown | undefined;
  evictions: ContextEviction[];
  compaction: CompactionPlan | undefined;
  compactionBlockedBy: CompactionBlock | undefined;
};

export class ContextOverflowError extends Error {
  readonly inputTokens: number;
  readonly inputBudget: number;
  readonly ceiling: number;
  readonly pinnedTokens: number;
  readonly floorTokens: number;
  readonly level: number;
  readonly lastLevel: boolean;
  readonly protection: ProtectionLevel;
  readonly breakdown: PinnedBreakdown | undefined;
  readonly evictions: ContextEviction[];
  readonly compaction: CompactionPlan | undefined;
  readonly compactionBlockedBy: CompactionBlock | undefined;

  constructor(facts: ContextOverflowFacts) {
    super(`context needs ${facts.inputTokens} tokens but the input budget is ${facts.inputBudget} at protection level ${facts.level}`);
    this.name = 'ContextOverflowError';
    this.inputTokens = facts.inputTokens;
    this.inputBudget = facts.inputBudget;
    this.ceiling = facts.ceiling;
    this.pinnedTokens = facts.pinnedTokens;
    this.floorTokens = facts.floorTokens;
    this.level = facts.level;
    this.lastLevel = facts.lastLevel;
    this.protection = facts.protection;
    this.breakdown = facts.breakdown;
    this.evictions = facts.evictions;
    this.compaction = facts.compaction;
    this.compactionBlockedBy = facts.compactionBlockedBy;
  }
}

export class PrefixChangedError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`context prefix changed within a run: expected digest ${expected} but built ${actual}`);
    this.name = 'PrefixChangedError';
    this.expected = expected;
    this.actual = actual;
  }
}
