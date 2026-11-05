import { describe, expect, it } from 'vitest';
import { openResponsesStream, openResponsesTextReply, openingEvents, terminalEvent } from '@momonga/testkit';
import { userInput } from './gateway-helpers.ts';
import { startOpenResponsesGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

const UPSTREAM_REASONING_ID = 'rs_up_7';
const UPSTREAM_MESSAGE_ID = 'msg_up_7';
const ENCRYPTED = 'opaque-encrypted-reasoning-from-upstream';

const upstreamReasoning = { type: 'reasoning', id: UPSTREAM_REASONING_ID, summary: [], encrypted_content: ENCRYPTED };
const upstreamMessage = { type: 'message', id: UPSTREAM_MESSAGE_ID, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };

const statelessReasoningThenMessage = () =>
  openResponsesStream([
    ...openingEvents(),
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: UPSTREAM_REASONING_ID, summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: upstreamReasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...upstreamMessage, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: UPSTREAM_MESSAGE_ID, output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: UPSTREAM_MESSAGE_ID, output_index: 1, content_index: 0, delta: 'Done.' },
    { type: 'response.output_text.done', item_id: UPSTREAM_MESSAGE_ID, output_index: 1, content_index: 0, text: 'Done.' },
    { type: 'response.content_part.done', item_id: UPSTREAM_MESSAGE_ID, output_index: 1, content_index: 0, part: { type: 'output_text', text: 'Done.', annotations: [] } },
    { type: 'response.output_item.done', output_index: 1, item: upstreamMessage },
    terminalEvent({ kind: 'completed' }, [upstreamReasoning, upstreamMessage]),
  ]);

describe('the open-responses relay passes reasoning back in the stateless form of the vendored spec (W1)', () => {
  it('asks the upstream for reasoning.encrypted_content, since it sends store false', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])] });

    await streamResponse(gateway);

    const sent: any = gateway.fake.requests.at(-1)?.body;
    expect(sent.store).toBe(false);
    expect(sent.include).toEqual(['reasoning.encrypted_content']);
  });

  it('sends back the reasoning the upstream produced with its encrypted content, and no id the upstream did not issue', async () => {
    const gateway = await startOpenResponsesGateway({ script: [statelessReasoningThenMessage(), openResponsesTextReply(['ok'])] });
    const output: any[] = terminalOf(await streamResponse(gateway)).response.output;

    await streamResponse(gateway, { input: [...userInput('hello'), ...output, ...userInput('again')] });

    const sent: any = gateway.fake.requests.at(-1)?.body;
    const reasoning = sent.input.filter((item: any) => item.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].encrypted_content).toBe(ENCRYPTED);
    const forwardedIds = sent.input.flatMap((item: any) => (typeof item.id === 'string' ? [item.id] : []));
    expect(forwardedIds.filter((id: string) => id !== UPSTREAM_REASONING_ID && id !== UPSTREAM_MESSAGE_ID)).toEqual([]);
    expect(sent.include).toEqual(['reasoning.encrypted_content']);
  });
});
