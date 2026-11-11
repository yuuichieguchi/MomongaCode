import { describe, expect, it } from 'vitest';
import {
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicMessageEnd,
  anthropicMessageStart,
  anthropicStream,
  anthropicTextBlock,
  anthropicToolUseBlock,
} from '@momonga/testkit';
import { readFileTool, startAnthropicGateway, streamResponse, terminalOf, typesOf } from '../upstream-gateway-support.ts';

describe('anthropic adapter: a tool call cut off by max_tokens', () => {
  it('ends incomplete with the complete calls kept and the cut-off call kept as a partial call', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([
          anthropicMessageStart(),
          ...anthropicToolUseBlock(0, 'toolu_01', 'read_file', ['{"path":', ' "/tmp/a"}']),
          ...anthropicToolUseBlock(1, 'toolu_02', 'read_file', ['{"path": "/t']),
          ...anthropicMessageEnd('max_tokens'),
        ]),
      ],
    });
    const frames = await streamResponse(gateway, { tools: [readFileTool] });
    const terminal = terminalOf(frames);
    expect(typesOf(frames)).not.toContain('response.failed');
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    expect(terminal.response.output).toHaveLength(2);
    expect(terminal.response.output[0]).toMatchObject({ type: 'function_call', name: 'read_file', arguments: '{"path": "/tmp/a"}' });
    expect(terminal.response.output[1]).toMatchObject({ type: 'function_call', name: 'read_file', status: 'incomplete', arguments: '{"path": "/t' });
  });

  it('fails the continuation of a paused turn whose recorded tool input cannot be read', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([
          anthropicMessageStart(),
          ...anthropicTextBlock(0, ['part one, ']),
          anthropicBlockStart(1, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
          anthropicBlockDelta(1, { type: 'input_json_delta', partial_json: '{"query":' }),
          anthropicBlockStop(1),
          ...anthropicMessageEnd('pause_turn'),
        ]),
      ],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'upstream_protocol_error', type: 'model_error' });
    expect(terminal.response.error.message).toContain('paused');
    expect(gateway.fake.requests).toHaveLength(1);
  });
});
