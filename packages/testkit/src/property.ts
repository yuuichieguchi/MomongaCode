export type Generator = {
  readonly seed: number;
  next(): number;
  below(bound: number): number;
  pick<T>(choices: readonly T[]): T;
};

const UINT32 = 0x1_0000_0000;
const GOLDEN_GAMMA = 0x9e3779b9;

export const seededGenerator = (seed: number): Generator => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + GOLDEN_GAMMA) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35) >>> 0;
    return ((mixed ^ (mixed >>> 16)) >>> 0) / UINT32;
  };
  const below = (bound: number): number => {
    if (!Number.isSafeInteger(bound) || bound < 1) throw new RangeError(`below needs a positive whole bound, got ${bound}`);
    return Math.floor(next() * bound);
  };
  return {
    seed,
    next,
    below,
    pick: <T>(choices: readonly T[]): T => {
      const chosen = choices[below(choices.length)];
      if (chosen === undefined) throw new RangeError('pick needs at least one choice');
      return chosen;
    },
  };
};

export class PropertyFailure extends Error {
  readonly seed: number;
  readonly property: string;

  constructor(seed: number, property: string, cause: unknown) {
    super(`the property "${property}" fails for seed ${seed}; replay it with that seed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'PropertyFailure';
    this.seed = seed;
    this.property = property;
  }
}

export const forEachSeed = async (property: string, seeds: readonly number[], check: (generator: Generator) => Promise<void> | void): Promise<void> => {
  for (const seed of seeds) {
    try {
      await check(seededGenerator(seed));
    } catch (error) {
      throw new PropertyFailure(seed, property, error);
    }
  }
};

export const seedsFrom = (first: number, count: number): number[] => Array.from({ length: count }, (_, index) => first + index);
