import { MAX_JSON_DEPTH, newCallId } from '@momonga/foundation';
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
      emitter.beginCall(key, newCallId(clock), name);
      emitter.appendCallArguments(key, argumentsJson);
      closing.push(key);
    },
  }, plan.requireToolCalls);
  const closing: number[] = [];
  const closeCalls = async (): Promise<void> => {
    for (const key of closing.splice(0)) await emitter.completeCall(key);
  };
  const parsedEvents = (run: () => ReturnType<IncrementalJsonParser['push']>): ReturnType<IncrementalJsonParser['push']> => {
    try {
      return run();
    } catch (error) {
      if (error instanceof JsonSyntaxError) throw new MalformedOutputError(error.message);
      throw error;
    }
  };
  const feed = async (run: () => ReturnType<IncrementalJsonParser['push']>): Promise<void> => {
    for (const event of parsedEvents(run)) {
      reader.accept(event);
      await closeCalls();
    }
  };
  return {
    text: (text) => feed(() => parser.push(text)),
    toolCall: () => {
      throw new UpstreamProtocolError('the upstream sent native tool_calls to a constrained request');
    },
    finish: async (outcome) => {
      if (outcome === 'truncated') return;
      await feed(() => parser.end());
      reader.finish();
      await closeCalls();
    },
  };
};

const IGNORED_HANDLERS = { finalTextStarted: (): void => undefined, finalTextDelta: (): void => undefined, toolCall: (): void => undefined };

export const isAcceptedEnvelope = (content: string, plan: ConstrainedPlan): boolean => {
  const parser = new IncrementalJsonParser(LIMITS);
  const reader = new EnvelopeReader(plan.toolNames, IGNORED_HANDLERS, plan.requireToolCalls);
  try {
    for (const event of parser.push(content)) reader.accept(event);
    for (const event of parser.end()) reader.accept(event);
    reader.finish();
    return true;
  } catch (error) {
    if (error instanceof JsonSyntaxError || error instanceof MalformedOutputError) return false;
    throw error;
  }
};
