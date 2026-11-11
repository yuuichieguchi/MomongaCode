import openapi from '../vendor/open-responses/2026-04-24/openapi.json' with { type: 'json' };

export const OPEN_RESPONSES_OPENAPI: unknown = openapi;

const childOf = (holder: unknown, key: string): unknown => (typeof holder === 'object' && holder !== null && !Array.isArray(holder) ? (holder as Record<string, unknown>)[key] : undefined);

const requestOutputMinimum = (): number => {
  const variants = ['components', 'schemas', 'CreateResponseBody', 'properties', 'max_output_tokens', 'anyOf'].reduce(childOf, OPEN_RESPONSES_OPENAPI);
  const minimum = Array.isArray(variants) ? variants.map((variant: unknown) => childOf(variant, 'minimum')).find((value): value is number => typeof value === 'number') : undefined;
  if (minimum === undefined) throw new TypeError('Open Responses spec: CreateResponseBody.max_output_tokens states no minimum');
  return minimum;
};

export const MIN_REQUEST_OUTPUT_TOKENS = requestOutputMinimum();
