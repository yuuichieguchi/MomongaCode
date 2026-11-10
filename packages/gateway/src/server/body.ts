import { JsonDepthError, parseOutsideJson } from '@momonga/foundation';
import { invalidRequest } from '../core/errors.ts';

const payloadTooLarge = (maxBytes: number) =>
  invalidRequest('payload_too_large', `request body exceeds the limit of ${maxBytes} bytes`, null, 413);

export const parseRequestJson = (text: string, subject: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    if (error instanceof JsonDepthError) throw invalidRequest('json_too_deep', `${subject} is too deeply nested: ${error.message}`);
    if (error instanceof SyntaxError) throw invalidRequest('invalid_json', `${subject} is not valid JSON`);
    throw error;
  }
};

export const readJsonBody = async (request: Request, maxBytes: number): Promise<unknown> => {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) throw payloadTooLarge(maxBytes);
  if (request.body === null) throw invalidRequest('invalid_json', 'the request body is empty');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw payloadTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw invalidRequest('invalid_json', 'the request body is not valid UTF-8');
  }
  return parseRequestJson(text, 'the request body');
};
