import type { UntrustedError } from '@momonga/foundation';

export type SchemaProblem = { readonly pointer: string; readonly reason: string };

const othersText = (count: number): string => (count === 0 ? '' : ` (and ${count} more ${count === 1 ? 'error' : 'errors'})`);

export const schemaProblemOf = (errors: readonly UntrustedError[]): SchemaProblem => {
  const first = errors[0];
  if (first === undefined) return { pointer: '/', reason: 'schema violation' };
  const additional = first.keyword === 'additionalProperties' ? `/${String(first.params['additionalProperty'])}` : '';
  const pointer = `${first.instancePath}${additional}`;
  return { pointer: pointer === '' ? '/' : pointer, reason: `${first.message}${othersText(errors.length - 1)}` };
};

export const invalidSettingsMessage = (source: string, pointer: string, reason: string): string => `${source}: invalid settings at ${pointer}: ${reason}`;

export const describeSchemaErrors = (errors: readonly UntrustedError[]): string => {
  const { pointer, reason } = schemaProblemOf(errors);
  return `${pointer}: ${reason}`;
};
