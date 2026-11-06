import type { UntrustedError } from '@momonga/foundation';

export const describeSchemaErrors = (errors: readonly UntrustedError[]): string => {
  const first = errors[0];
  if (first === undefined) return '/: schema violation';
  const additional = first.keyword === 'additionalProperties' ? `/${String(first.params['additionalProperty'])}` : '';
  const pointer = `${first.instancePath}${additional}`;
  return `${pointer === '' ? '/' : pointer}: ${first.message}`;
};
