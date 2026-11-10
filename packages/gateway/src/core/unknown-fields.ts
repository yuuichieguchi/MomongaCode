import { invalidRequest } from './errors.ts';
import type { GatewayError } from './errors.ts';

export type UnknownFields = Record<string, unknown>;

export const unknownParameterError = (keys: readonly string[], display: string, reason: string): GatewayError => {
  const [first] = keys;
  if (first === undefined) throw new TypeError('unknownParameterError needs at least one unknown field');
  return invalidRequest('unknown_parameter', `unknown request field${keys.length === 1 ? '' : 's'} ${keys.join(', ')}: ${reason} for model "${display}"`, first);
};
