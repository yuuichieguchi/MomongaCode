export class PinnedOverflowError extends Error {
  readonly pinnedTokens: number;
  readonly inputBudget: number;

  constructor(pinnedTokens: number, inputBudget: number) {
    super(`pinned context needs ${pinnedTokens} tokens but the input budget is ${inputBudget}`);
    this.name = 'PinnedOverflowError';
    this.pinnedTokens = pinnedTokens;
    this.inputBudget = inputBudget;
  }
}

export class ContextOverflowError extends Error {
  readonly inputTokens: number;
  readonly inputBudget: number;
  readonly compactThroughSeq: number | undefined;

  constructor(inputTokens: number, inputBudget: number, compactThroughSeq: number | undefined) {
    super(`context needs ${inputTokens} tokens but the input budget is ${inputBudget} and nothing evictable remains`);
    this.name = 'ContextOverflowError';
    this.inputTokens = inputTokens;
    this.inputBudget = inputBudget;
    this.compactThroughSeq = compactThroughSeq;
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
