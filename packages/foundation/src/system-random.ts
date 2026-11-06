import { randomBytes, randomUUID } from 'node:crypto';
import type { Random } from './random.ts';

export const systemRandom: Random = {
  float: () => Math.random(),
  bytes: (length) => new Uint8Array(randomBytes(length)),
  hex: (byteLength) => randomBytes(byteLength).toString('hex'),
  uuid: () => randomUUID(),
};
