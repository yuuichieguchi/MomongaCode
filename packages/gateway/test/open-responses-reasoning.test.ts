import { describe, expect, it } from 'vitest';
import { openResponsesStream, openResponsesTextReply, openingEvents, terminalEvent } from '@momonga/testkit';
import { userInput } from './gateway-helpers.ts';
import { fixtureText } from './ollama-support.ts';
import { verifiedEnvelope } from './reasoning-origin-support.ts';
import { startOpenResponsesGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';

const REASONING = 'Consider the file layout first.';
const ENCRYPTED = 'opaque-encrypted-reasoning-from-upstream';

const reasoningItem = { type: 'reasoning', id: 'rs_up_1', summary: [], content: [{ type: 'reasoning_text', text: REASONING }], encrypted_content: ENCRYPTED };
const messageItem = { type: 'message', id: 'msg_up_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };

const reasoningThenMessage = () =>
  openResponsesStream([
    ...openingEvents(),
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_up_1', summary: [], content: [] } },
    { type: 'response.content_part.added', item_id: 'rs_up_1', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } },
    { type: 'response.reasoning.delta', item_id: 'rs_up_1', output_index: 0, content_index: 0, delta: 'Consider the file ' },
    { type: 'response.reasoning.delta', item_id: 'rs_up_1', output_index: 0, content_index: 0, delta: 'layout first.' },
    { type: 'response.reasoning.done', item_id: 'rs_up_1', output_index: 0, content_index: 0, text: REASONING },
    { type: 'response.content_part.done', item_id: 'rs_up_1', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: REASONING } },
    { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
    { type: 'response.output_item.added', output_index: 1, item: { ...messageItem, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_up_1', output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_up_1', output_index: 1, content_index: 0, delta: 'Done.' },
    { type: 'response.output_text.done', item_id: 'msg_up_1', output_index: 1, content_index: 0, text: 'Done.' },
    { type: 'response.content_part.done', item_id: 'msg_up_1', output_index: 1, content_index: 0, part: { type: 'output_text', text: 'Done.', annotations: [] } },
    { type: 'response.output_item.done', output_index: 1, item: messageItem },
    terminalEvent({ kind: 'completed' }, [reasoningItem, messageItem]),
  ]);

describe('open-responses reasoning (R2b)', () => {
  it('passes the upstream reasoning events and item through', async () => {
    const gateway = await startOpenResponsesGateway({ script: [reasoningThenMessage()] });

    const frames = await streamResponse(gateway);

    expect(frames.filter((frame) => frame.data.type === 'response.reasoning.delta').map((frame) => frame.data.delta).join('')).toBe(REASONING);
    const output: any[] = terminalOf(frames).response.output;
    expect(output.map((item) => item.type)).toEqual(['reasoning', 'message']);
    expect(output[0]).toMatchObject({ type: 'reasoning', content: [{ type: 'reasoning_text', text: REASONING }] });
    expect(output[0].encrypted_content).not.toBe(ENCRYPTED);
    expect(verifiedEnvelope(output[0].encrypted_content)).toMatchObject({ adapter: 'open-responses' });
  });

  it('passes the reasoning_summary_text deltas of a recorded Ollama /v1/responses stream through as reasoning', async () => {
    const frames = fixtureText('qwen-v1-responses-reasoning.sse')
      .split('\n\n')
      .filter((block) => block.trim() !== '')
      .map((block) => {
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
        return { ...(event === undefined ? {} : { event }), data: JSON.parse(data) };
      });
    const summaryDeltas = frames.filter((frame) => frame.data.type === 'response.reasoning_summary_text.delta').map((frame) => frame.data.delta as string);
    const recordedSummary = summaryDeltas.join('');
    expect(recordedSummary.length).toBeGreaterThan(0);
    const gateway = await startOpenResponsesGateway({ script: [{ kind: 'stream', frames }] });

    const out = await streamResponse(gateway);

    const reasoningDeltas = out
      .filter((frame) => frame.data.type === 'response.reasoning_summary_text.delta' || frame.data.type === 'response.reasoning.delta')
      .map((frame) => frame.data.delta)
      .join('');
    expect(reasoningDeltas).toBe(recordedSummary);
    const output: any[] = terminalOf(out).response.output;
    expect(output.map((item) => item.type)).toEqual(['reasoning', 'message']);
    expect(output[0].summary).toEqual([{ type: 'summary_text', text: recordedSummary }]);
  });

  it('leaves off the wire a hand-built reasoning item whose encrypted_content carries no gateway marker', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])] });
    const history = {
      type: 'reasoning',
      id: 'rs_up_1',
      summary: [{ type: 'summary_text', text: 'Thought about the layout.' }],
      encrypted_content: ENCRYPTED,
    };

    await streamResponse(gateway, {
      input: [...userInput('first'), history, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }, ...userInput('again')],
    });

    const sent: any = gateway.fake.requests.at(-1)?.body;
    expect(sent.input.map((item: any) => item.type)).toEqual(['message', 'message', 'message']);
    expect(JSON.stringify(sent.input).includes(ENCRYPTED)).toBe(false);
  });

  it('sends a reasoning item the upstream produced back unchanged in the next request', async () => {
    const gateway = await startOpenResponsesGateway({ script: [reasoningThenMessage(), openResponsesTextReply(['ok'])] });
    const output: any[] = terminalOf(await streamResponse(gateway)).response.output;

    await streamResponse(gateway, { input: [...userInput('hello'), ...output, ...userInput('again')] });

    const sent: any = gateway.fake.requests.at(-1)?.body;
    const reasoning = sent.input.filter((item: any) => item.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ encrypted_content: ENCRYPTED, content: [{ type: 'reasoning_text', text: REASONING }] });
  });
});
