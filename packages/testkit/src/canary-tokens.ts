import { randomBytes } from 'node:crypto';

const LABEL_PATTERN = /^[a-z][a-z0-9_]*$/;

const RANDOM_BYTES = 48;

const PREFIX_CHARS_FOUND = 40;

export const createCanary = (label: string): string => {
  if (!LABEL_PATTERN.test(label)) throw new Error(`a canary label is lowercase letters, digits and underscores, got "${label}"`);
  return `canary-${label}-${randomBytes(RANDOM_BYTES).toString('base64url')}`;
};

export const findCanaries = (text: string, canaries: readonly string[]): string[] =>
  canaries.filter((canary) => text.includes(canary.slice(0, PREFIX_CHARS_FOUND)));
