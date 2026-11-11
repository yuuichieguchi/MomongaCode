export type FakeClock = {
  now(): number;
  monotonicMs(): number;
  advance(ms: number): void;
  set(ms: number): void;
  stepWall(ms: number): void;
};

export const createFakeClock = (startMs: number): FakeClock => {
  let wall = startMs;
  let monotonic = startMs;
  const advance = (ms: number): void => {
    wall += ms;
    monotonic += ms;
  };
  return {
    now: () => wall,
    monotonicMs: () => monotonic,
    advance,
    set: (ms) => advance(ms - wall),
    stepWall: (ms) => {
      wall += ms;
    },
  };
};
