export type Random = {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
};

export const seeded = (seed: number): Random => {
  let state = Math.imul(seed >>> 0, 0x9e3779b1) >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T,>(values: readonly T[]): T => {
      const value = values[int(0, values.length - 1)];
      if (value === undefined) throw new Error('pick from an empty list');
      return value;
    },
    chance: (probability) => next() < probability,
  };
};
