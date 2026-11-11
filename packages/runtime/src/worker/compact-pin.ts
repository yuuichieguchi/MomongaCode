import { isRecord } from '@momonga/foundation';
import { COMPACT_PIN_KEY } from '@momonga/protocol';

export type CompactPin = { instructions?: string };

export const compactPinOf = (instructions: string | undefined): { compact: CompactPin } => ({ [COMPACT_PIN_KEY]: instructions === undefined ? {} : { instructions } });

export const readCompactPin = (pins: Record<string, unknown>): CompactPin | undefined => {
  const value = pins[COMPACT_PIN_KEY];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError('the compact pin of this run is malformed');
  const { instructions } = value;
  if (instructions !== undefined && typeof instructions !== 'string') throw new TypeError('the compact pin of this run holds malformed instructions');
  return instructions === undefined ? {} : { instructions };
};

export const compactInputOf = (instructions: string | undefined): string => (instructions === undefined ? '/compact' : `/compact ${instructions}`);
