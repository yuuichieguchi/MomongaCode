import { parseOutsideJson } from '@momonga/foundation';
import { ToolExecutionError } from '../types.ts';
import type { ForgeOperationName } from '../operations/spec.ts';
import type { ForgeDescriptor } from './descriptor.ts';
import { textAt, valueAt } from './jsonpath.ts';

export const MAX_FORGE_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ForgeFields = Readonly<Record<string, string>>;

export type ForgeAnswer = { status: 'success' | 'already_exists' | 'conflict'; items: ForgeFields[]; fields: ForgeFields };

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

const fill = (template: string, variables: Readonly<Record<string, string>>, encode: (value: string) => string): string =>
  template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) throw new ToolExecutionError(`the forge request needs a value for ${key}`);
    return encode(value);
  });

const readCapped = async (response: Response): Promise<string> => {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let step = await reader.read(); !step.done; step = await reader.read()) {
    size += step.value.byteLength;
    if (size > MAX_FORGE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ToolExecutionError(`the forge response is larger than ${MAX_FORGE_RESPONSE_BYTES} bytes`);
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const fieldsOf = (document: unknown, result: Readonly<Record<string, string>>): ForgeFields =>
  Object.fromEntries(Object.entries(result).flatMap(([name, path]) => {
    const value = textAt(document, path);
    return value === undefined ? [] : [[name, value]];
  }));

export type ForgeHttpCall = {
  descriptor: ForgeDescriptor;
  apiBaseUrl: string;
  credential: string;
  variables: Readonly<Record<string, string>>;
  operation: ForgeOperationName;
  signal: AbortSignal;
  boundMs: number;
  fetch: ForgeFetch;
};

export type ForgeFetch = (url: URL, init: { boundMs: number; method: string; redirect: 'error'; signal: AbortSignal; headers: Record<string, string>; body?: string }) => Promise<Response>;

export const callForge = async (call: ForgeHttpCall): Promise<ForgeAnswer> => {
  const operation = call.descriptor.operations[call.operation];
  const url = new URL(call.apiBaseUrl.replace(/\/+$/, '') + fill(operation.path, call.variables, encodeURIComponent));
  for (const [key, template] of Object.entries(operation.query ?? {})) url.searchParams.set(key, fill(template, call.variables, (value) => value));
  const body = operation.body === undefined ? undefined : JSON.stringify(Object.fromEntries(Object.entries(operation.body).map(([key, template]) => [key, fill(template, call.variables, (value) => value)])));
  const response = await call.fetch(url, {
    method: operation.method,
    redirect: 'error',
    signal: call.signal,
    boundMs: call.boundMs,
    headers: {
      accept: 'application/json',
      [call.descriptor.auth.header]: `${call.descriptor.auth.prefix}${call.credential}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  });
  const text = await readCapped(response);
  const status = operation.success.includes(response.status)
    ? 'success'
    : operation.alreadyExists?.includes(response.status) === true
      ? 'already_exists'
      : operation.conflict?.includes(response.status) === true
        ? 'conflict'
        : undefined;
  if (status === undefined) throw new ToolExecutionError(`the forge answered ${operation.method} ${url.pathname} with status ${response.status}`);
  if (status !== 'success' || text === '') return { status, items: [], fields: {} };
  const document = parseOutsideJson(text);
  const list = operation.items === undefined ? undefined : valueAt(document, operation.items);
  const items = Array.isArray(list) ? list.map((item) => fieldsOf(item, operation.result)) : [];
  return { status, items, fields: operation.items === undefined ? fieldsOf(document, operation.result) : {} };
};
