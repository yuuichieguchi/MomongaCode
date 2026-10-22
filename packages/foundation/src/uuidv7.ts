import { randomFillSync } from 'node:crypto';
import { systemClock } from './clock.ts';
import type { Clock } from './clock.ts';

type GeneratorState = { ms: bigint; sequence: bigint };

const SEQUENCE_BITS = 74n;
const SEQUENCE_SEED_MASK = (1n << (SEQUENCE_BITS - 1n)) - 1n;
const SEQUENCE_LIMIT = 1n << SEQUENCE_BITS;
const RAND_B_BITS = 62n;
const RAND_B_MASK = (1n << RAND_B_BITS) - 1n;
const MAX_TIMESTAMP_MS = (1n << 48n) - 1n;

const statesByClock = new WeakMap<Clock, GeneratorState>();

const defaultRandom = (length: number): Uint8Array => randomFillSync(new Uint8Array(length));

const seedSequence = (random: (length: number) => Uint8Array): bigint => {
  const bytes = random(10);
  if (bytes.length < 10) throw new RangeError(`uuidv7: random source returned ${bytes.length} bytes, expected 10`);
  let seed = 0n;
  for (let index = 0; index < 10; index += 1) seed = (seed << 8n) | BigInt(bytes[index] as number);
  return seed & SEQUENCE_SEED_MASK;
};

const nextState = (previous: GeneratorState | undefined, nowMs: bigint, random: (length: number) => Uint8Array): GeneratorState => {
  if (previous === undefined || nowMs > previous.ms) return { ms: nowMs, sequence: seedSequence(random) };
  const sequence = previous.sequence + 1n;
  if (sequence >= SEQUENCE_LIMIT) return { ms: previous.ms + 1n, sequence: 0n };
  return { ms: previous.ms, sequence };
};

const toHex = (value: bigint, digits: number): string => value.toString(16).padStart(digits, '0');

export const uuidv7 = (clock: Clock = systemClock, random: (length: number) => Uint8Array = defaultRandom): string => {
  const nowMs = BigInt(Math.trunc(clock.now()));
  if (nowMs < 0n || nowMs > MAX_TIMESTAMP_MS) throw new RangeError(`uuidv7: clock value ${nowMs} does not fit in 48 bits`);
  const state = nextState(statesByClock.get(clock), nowMs, random);
  statesByClock.set(clock, state);
  const randA = state.sequence >> RAND_B_BITS;
  const randB = state.sequence & RAND_B_MASK;
  const variantAndRandB = (0b10n << RAND_B_BITS) | randB;
  const timestamp = toHex(state.ms, 12);
  const versionAndRandA = toHex((0x7n << 12n) | randA, 4);
  const tail = toHex(variantAndRandB, 16);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-${versionAndRandA}-${tail.slice(0, 4)}-${tail.slice(4)}`;
};
