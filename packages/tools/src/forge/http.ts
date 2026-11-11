import { parseOutsideJson } from '@momonga/foundation';
import { ToolExecutionError } from '../types.ts';
import type { ForgeOperationName } from '../operations/spec.ts';
import type { ForgeAnswerOutcome, ForgeDescriptor, ForgeErrorText, ForgeOperationDescriptor } from './descriptor.ts';
import { textAt, valueAt } from './jsonpath.ts';

export const MAX_FORGE_RESPONSE_BYTES = 4 * 1024 * 1024;

export type ForgeFields = Readonly<Record<string, string>>;

export type ForgeAnswer = { status: 'success' | ForgeAnswerOutcome; message: string; items: ForgeFields[]; fields: ForgeFields };

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

const NEXT_PAGE = /<([^>]+)>\s*;\s*rel="?next"?/;

const nextPageOf = (response: Response, apiBaseUrl: string): URL | undefined => {
  const header = response.headers.get('link');
  const next = header === null ? undefined : NEXT_PAGE.exec(header)?.[1];
  if (next === undefined) return undefined;
  const url = new URL(next, apiBaseUrl);
  if (url.origin !== new URL(apiBaseUrl).origin) throw new ToolExecutionError(`the forge named a next page at ${url.origin}, which is not the forge at ${new URL(apiBaseUrl).origin}`);
  return url;
};

const stringsAt = (document: unknown, path: string): string[] => {
  const value = valueAt(document, path);
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

const errorTextOf = (text: string, form: ForgeErrorText): string => {
  if (text === '') return '';
  const document = parseOutsideJson(text);
  const details = form.details === undefined ? [] : valueAt(document, form.details);
  const { detail } = form;
  const detailTexts = Array.isArray(details) && detail !== undefined ? details.flatMap((entry) => stringsAt(entry, detail)) : [];
  return [...stringsAt(document, form.message), ...detailTexts].join(': ');
};

const outcomeOf = (operation: ForgeOperationDescriptor, status: number, message: string): 'success' | ForgeAnswerOutcome | undefined => {
  if (operation.success.includes(status)) return 'success';
  return operation.answers?.find((answer) => answer.status === status && (answer.messageIncludes === undefined || message.includes(answer.messageIncludes)))?.outcome;
};

const itemsOf = (document: unknown, operation: ForgeOperationDescriptor & { items: string }): ForgeFields[] => {
  const list = valueAt(document, operation.items);
  return Array.isArray(list) ? list.map((item) => fieldsOf(item, operation.result)) : [];
};

export const callForge = async (call: ForgeHttpCall): Promise<ForgeAnswer> => {
  const operation = call.descriptor.operations[call.operation];
  const url = new URL(call.apiBaseUrl.replace(/\/+$/, '') + fill(operation.path, call.variables, encodeURIComponent));
  for (const [key, template] of Object.entries(operation.query ?? {})) url.searchParams.set(key, fill(template, call.variables, (value) => value));
  const body = operation.body === undefined ? undefined : JSON.stringify(Object.fromEntries(Object.entries(operation.body).map(([key, template]) => [key, fill(template, call.variables, (value) => value)])));
  const ask = (at: URL): Promise<Response> =>
    call.fetch(at, {
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
  const items: ForgeFields[] = [];
  for (let at: URL | undefined = url; at !== undefined; ) {
    const response = await ask(at);
    const text = await readCapped(response);
    const message = operation.success.includes(response.status) ? '' : errorTextOf(text, call.descriptor.errorText);
    const status = outcomeOf(operation, response.status, message);
    if (status === undefined) throw new ToolExecutionError(`the forge answered ${operation.method} ${at.pathname} with status ${response.status}${message === '' ? '' : `: ${message}`}`);
    if (status !== 'success') return { status, message, items: [], fields: {} };
    if (text === '') return { status, message, items, fields: {} };
    const document = parseOutsideJson(text);
    if (operation.items === undefined) return { status, message, items: [], fields: fieldsOf(document, operation.result) };
    items.push(...itemsOf(document, { ...operation, items: operation.items }));
    at = operation.paging === 'link' ? nextPageOf(response, call.apiBaseUrl) : undefined;
  }
  return { status: 'success', message: '', items, fields: {} };
};
