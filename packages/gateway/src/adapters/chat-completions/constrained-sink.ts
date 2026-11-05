import { MAX_JSON_DEPTH, uuidv7 } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { EnvelopeReader } from './envelope-reader.ts';
import { MalformedOutputError, UpstreamProtocolError } from '../shared/failures.ts';
import { IncrementalJsonParser, JsonSyntaxError } from './incremental-json.ts';
import type { IncrementalJsonLimits } from './incremental-json.ts';
import { MAX_TOOL_CALLS } from '../shared/limits.ts';
import { MAX_ENVELOPE_CHARS, MAX_JSON_ATOM_CHARS, MAX_JSON_KEY_CHARS } from './limits.ts';
import type { ResponseEmitter } from '../shared/response-emitter.ts';
import type { ContentSink } from './stream-driver.ts';

const LIMITS: IncrementalJsonLimits = {
  maxChars: MAX_ENVELOPE_CHARS,
  maxDepth: MAX_JSON_DEPTH,
  maxKeyChars: MAX_JSON_KEY_CHARS,
  maxAtomChars: MAX_JSON_ATOM_CHARS,
};

export type ConstrainedPlan = { toolNames: ReadonlySet<string>; requireToolCalls: boolean };

export const createConstrainedSink = (emitter: ResponseEmitter, plan: ConstrainedPlan, clock: Clock): ContentSink => {
  const parser = new IncrementalJsonParser(LIMITS);
  let nextKey = 0;
  const reader = new EnvelopeReader(plan.toolNames, {
    finalTextStarted: () => emitter.openMessage(),
    finalTextDelta: (text) => emitter.appendText(text),
    toolCall: ({ name, argumentsJson }) => {
      if (nextKey >= MAX_TOOL_CALLS) throw new MalformedOutputError(`the model emitted more than ${MAX_TOOL_CALLS} tool calls`);
      const key = nextKey;
      nextKey += 1;
      emitter.beginCall(key, `call_${uuidv7(clock).replaceAll('-', '')}`, name);
      emitter.appendCallArguments(key, argumentsJson);
      emitter.completeCall(key);
    },
  }, plan.requireToolCalls);
  const feed = (run: () => ReturnType<IncrementalJsonParser['push']>): void => {
    try {
      for (const event of run()) reader.accept(event);
    } catch (error) {
      if (error instanceof JsonSyntaxError) throw new MalformedOutputError(error.message);
      throw error;
    }
  };
  return {
    text: (text) => feed(() => parser.push(text)),
    toolCall: () => {
      throw new UpstreamProtocolError('the upstream sent native tool_calls to a constrained request');
    },
    finish: (outcome) => {
      if (outcome === 'truncated') return;
      feed(() => parser.end());
      reader.finish();
    },
  };
};
