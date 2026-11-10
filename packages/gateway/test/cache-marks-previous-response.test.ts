import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { postJson, readJson, startGateway } from './gateway-helpers.ts';

const message = (role: 'system' | 'user', text: string) => ({ type: 'message', role, content: text });

const answering = (model: string) => ({ events: textResponseEvents({ model, chunks: ['ok'], usage: usageOf(9, 3) }) });

describe('cache marks count the leading items of the request own input, also after previous_response_id', () => {
  it('shifts every mark by the number of stored items the gateway prepends', async () => {
    const primary = createScriptedAdapter({ calls: [answering('scripted-primary'), answering('scripted-primary')] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });

    const first = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', store: true, input: [message('system', 'rules'), message('user', 'one')] }));
    expect(first.status).toBe(200);
    const stored = primary.calls[0]?.request.input.length ?? 0;
    const output = (first.body.output as unknown[]).length;

    const second = await readJson(
      await postJson(client, '/v1/responses', {
        model: 'scripted/scripted-primary',
        previous_response_id: first.body.id,
        input: [message('user', 'two'), message('user', 'three')],
        momonga: { cache: { stable: 0, fixed: 1, previousHistory: 1, history: 2 } },
      }),
    );

    expect(second.status).toBe(200);
    const offset = stored + output;
    expect(primary.calls[1]?.request.input).toHaveLength(offset + 2);
    expect(primary.calls[1]?.request.cacheMarks).toEqual({ stable: offset, fixed: offset + 1, previousHistory: offset + 1, history: offset + 2 });
  });
});
