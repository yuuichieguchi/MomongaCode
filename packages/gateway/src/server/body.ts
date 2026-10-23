import { invalidRequest } from '../core/errors.ts';

const payloadTooLarge = (maxBytes: number) =>
  invalidRequest('payload_too_large', `request body exceeds the limit of ${maxBytes} bytes`, null, 413);

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
  try {
    return JSON.parse(text);
  } catch (error) {
    throw invalidRequest('invalid_json', `the request body is not valid JSON: ${(error as Error).message}`);
  }
};
