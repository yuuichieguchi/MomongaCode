import { describe, expect, it } from 'vitest';
import { PROMPT_IMAGE_MAX_BYTES, PROMPT_TEXT_MAX_CHARS } from '@momonga/protocol';
import { startService } from './helpers.ts';

const pngOf = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64');

describe('the body limit of the prompt routes, derived from the schema', () => {
  it('accepts a prompt with a pasted image of the largest size the paste allows', async () => {
    const env = await startService({ imageInput: true });
    const session = await env.createSession();
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'what is this', images: [{ mediaType: 'image/png', data: pngOf(PROMPT_IMAGE_MAX_BYTES) }] } });
    expect(response.status).toBe(202);
  });

  it('accepts a prompt of the largest text, in characters that take several bytes', async () => {
    const env = await startService();
    const session = await env.createSession();
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'é'.repeat(PROMPT_TEXT_MAX_CHARS) } });
    expect(response.status).toBe(202);
  });

  it('refuses an image larger than the paste allows with 413 that names the image', async () => {
    const env = await startService({ imageInput: true });
    const session = await env.createSession();
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'what is this', images: [{ mediaType: 'image/png', data: pngOf(PROMPT_IMAGE_MAX_BYTES + 3) }] } });
    expect(response.status).toBe(413);
    expect(response.json.error.message).toContain('image');
    expect(env.store.listRuns(session.id)).toEqual([]);
  });
});
