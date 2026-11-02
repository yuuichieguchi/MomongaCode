import { UpstreamProtocolError } from '../shared/failures.ts';
import { MAX_TOOL_CALLS } from '../shared/limits.ts';
import type { ResponseEmitter } from '../shared/response-emitter.ts';
import type { ContentSink } from './stream-driver.ts';
import type { ToolCallFragment } from './upstream-chunk.ts';

export const createNativeSink = (emitter: ResponseEmitter): ContentSink => ({
  text: (text) => emitter.appendText(text),
  toolCall: (fragment: ToolCallFragment) => {
    if (!emitter.hasCall(fragment.index)) {
      if (emitter.callCount >= MAX_TOOL_CALLS) {
        throw new UpstreamProtocolError(`the upstream sent more than ${MAX_TOOL_CALLS} tool calls`);
      }
      if (fragment.id === undefined || fragment.id === '' || fragment.name === undefined || fragment.name === '') {
        throw new UpstreamProtocolError(`the first fragment of tool call ${fragment.index} lacks an id or a function name`);
      }
      emitter.beginCall(fragment.index, fragment.id, fragment.name);
    } else if (fragment.name !== undefined && fragment.name !== '' && fragment.name !== emitter.callName(fragment.index)) {
      throw new UpstreamProtocolError(`tool call ${fragment.index} changed its function name mid-stream`);
    }
    if (fragment.arguments !== undefined) emitter.appendCallArguments(fragment.index, fragment.arguments);
  },
  finish: () => undefined,
});
