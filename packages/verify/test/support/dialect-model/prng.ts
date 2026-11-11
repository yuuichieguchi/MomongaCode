export interface Rng {
  next(): number;
  int(bound: number): number;
  range(low: number, high: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  fork(label: number): Rng;
}

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const createRng = (seed: number): Rng => {
  const raw = mulberry32(seed);
  const rng: Rng = {
    next: raw,
    int: (bound) => Math.floor(raw() * bound),
    range: (low, high) => low + Math.floor(raw() * (high - low + 1)),
    chance: (probability) => raw() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick from an empty list');
      return items[Math.floor(raw() * items.length)] as never;
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(raw() * (index + 1));
        [copy[index], copy[other]] = [copy[other] as never, copy[index] as never];
      }
      return copy;
    },
    fork: (label) => createRng(Math.imul(seed ^ 0x9e3779b9, 31) + Math.imul(label + 1, 0x85ebca6b)),
  };
  return rng;
};

export const hashString = (text: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
