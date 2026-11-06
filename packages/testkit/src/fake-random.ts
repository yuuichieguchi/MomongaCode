import type { Random } from '@momonga/foundation';

const MODULUS = 2 ** 32;

const nextState = (state: number): number => (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

export const createFakeRandom = (seed: number): Random => {
  let state = seed >>> 0;
  const next = (): number => {
    state = nextState(state);
    return state;
  };
  const bytes = (length: number): Uint8Array => Uint8Array.from({ length }, () => next() & 0xff);
  const hex = (byteLength: number): string => Array.from(bytes(byteLength), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    float: () => next() / MODULUS,
    bytes,
    hex,
    uuid: () => {
      const digits = hex(16);
      return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-4${digits.slice(13, 16)}-8${digits.slice(17, 20)}-${digits.slice(20, 32)}`;
    },
  };
};
