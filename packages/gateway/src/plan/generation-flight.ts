export type GenerationFlight<T> = {
  at(generation: number): T | undefined;
  start(generation: number, flight: T): void;
  keepFor(generation: number): void;
  abandon(flight: T): void;
  clear(): void;
  held(): readonly number[];
};

export const createGenerationFlight = <T>(): GenerationFlight<T> => {
  let entry: { generation: number; flight: T } | undefined;
  return {
    at: (generation) => (entry?.generation === generation ? entry.flight : undefined),
    start: (generation, flight) => {
      entry = { generation, flight };
    },
    keepFor: (generation) => {
      if (entry?.generation !== generation) entry = undefined;
    },
    abandon: (flight) => {
      if (entry?.flight === flight) entry = undefined;
    },
    clear: () => {
      entry = undefined;
    },
    held: () => (entry === undefined ? [] : [entry.generation]),
  };
};
