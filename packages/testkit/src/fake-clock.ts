export type FakeClock = {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
};

export const createFakeClock = (startMs: number): FakeClock => {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
};
