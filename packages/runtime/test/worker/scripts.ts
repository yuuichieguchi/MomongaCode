import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { FunctionCallItem, ItemField, MessageItem, PlanAccountRef, ResponseResource, RunEventPayload, StreamEvent, Usage } from '@momonga/protocol';
import { responseResource, textResponseEvents, usageOf } from '@momonga/testkit';
import { deferred } from './deferred.ts';
import type { ScriptStep } from './fake-gateway.ts';

export const MODEL_ALIAS = 'fm';

export type ScriptedCall = { callId: string; name: string; args: Record<string, unknown> };

export const functionCallItem = (call: ScriptedCall): FunctionCallItem => ({
  type: 'function_call',
  id: `fc_${call.callId}`,
  call_id: call.callId,
  name: call.name,
  arguments: JSON.stringify(call.args),
  status: 'completed',
});

export const requestedOffering = (step: number, toolNames: readonly string[]): RunEventPayload => {
  const body = {
    model: MODEL_ALIAS,
    input: [],
    tools: toolNames.map((name) => ({ type: 'function', name, description: name, parameters: { type: 'object', properties: {} } })),
    store: false,
    stream: true,
  };
  return { type: 'model.requested', step, attempt: 1, digest: sha256Hex(canonicalJson(body)), body };
};

export const assistantMessage = (id: string, text: string): MessageItem => ({
  type: 'message',
  id,
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});

let responseCounter = 0;

export const resetResponseIds = (): void => {
  responseCounter = 0;
};

const nextResponseId = (): string => {
  responseCounter += 1;
  return `resp_${responseCounter}`;
};

const terminal = (
  type: 'response.completed' | 'response.incomplete',
  output: ItemField[],
  usage: Usage,
  sequence: number,
  incompleteReason?: string,
): StreamEvent => {
  const resource: ResponseResource = {
    ...responseResource({ id: nextResponseId(), model: MODEL_ALIAS, status: type === 'response.completed' ? 'completed' : 'incomplete', output, usage }),
    incomplete_details: incompleteReason === undefined ? null : { reason: incompleteReason },
  };
  return { type, sequence_number: sequence, response: resource };
};

const itemEvents = (output: ItemField[]): StreamEvent[] =>
  output.flatMap((item, index): StreamEvent[] => [
    { type: 'response.output_item.added', sequence_number: 0, output_index: index, item },
    { type: 'response.output_item.done', sequence_number: 0, output_index: index, item },
  ]);

const created = (): StreamEvent => ({
  type: 'response.created',
  sequence_number: 0,
  response: responseResource({ id: nextResponseId(), model: MODEL_ALIAS, status: 'in_progress' }),
});

const numbered = (events: StreamEvent[]): StreamEvent[] => events.map((event, index) => ({ ...event, sequence_number: index }));

export type ScriptedUsage = Usage | 'auto';

const PLACEHOLDER_USAGE = usageOf(0, 0);

const scriptedUsage = (usage: ScriptedUsage): Usage => (usage === 'auto' ? PLACEHOLDER_USAGE : usage);

const autoFlag = (usage: ScriptedUsage): { autoUsage?: true } => (usage === 'auto' ? { autoUsage: true } : {});

export const textStep = (text: string, options: { usage?: ScriptedUsage; chunks?: string[]; itemId?: string } = {}): ScriptStep => {
  const usage = options.usage ?? 'auto';
  return {
    events: textResponseEvents({
      model: MODEL_ALIAS,
      chunks: options.chunks ?? [text],
      usage: scriptedUsage(usage),
      itemId: options.itemId ?? `msg_${nextResponseId()}`,
    }),
    ...autoFlag(usage),
  };
};

export const outputStep = (output: ItemField[], usage: ScriptedUsage = 'auto'): ScriptStep => ({
  events: numbered([created(), ...itemEvents(output), terminal('response.completed', output, scriptedUsage(usage), 0)]),
  ...autoFlag(usage),
});

export const callsStep = (calls: ScriptedCall[], usage: ScriptedUsage = 'auto'): ScriptStep => outputStep(calls.map(functionCallItem), usage);

export const textThenCallsStep = (text: string, calls: ScriptedCall[], usage: ScriptedUsage = 'auto'): ScriptStep => {
  const itemId = `msg_${nextResponseId()}`;
  const message = assistantMessage(itemId, text);
  const output: ItemField[] = [message, ...calls.map(functionCallItem)];
  const delta: StreamEvent = { type: 'response.output_text.delta', sequence_number: 0, item_id: itemId, output_index: 0, content_index: 0, delta: text };
  const [messageAdded, messageDone, ...callEvents] = itemEvents(output);
  return {
    events: numbered([created(), messageAdded as StreamEvent, delta, messageDone as StreamEvent, ...callEvents, terminal('response.completed', output, scriptedUsage(usage), 0)]),
    ...autoFlag(usage),
  };
};

export const incompleteStep = (output: ItemField[], reason = 'max_output_tokens', usage: ScriptedUsage = 'auto'): ScriptStep => ({
  events: numbered([created(), ...itemEvents(output), terminal('response.incomplete', output, scriptedUsage(usage), 0, reason)]),
  ...autoFlag(usage),
});

export const failedStep = (code: string, type: 'server_error' | 'model_error' | 'too_many_requests' = 'server_error', plan?: PlanAccountRef): ScriptStep => {
  const base = responseResource({ id: nextResponseId(), model: MODEL_ALIAS, status: 'failed' });
  const error = { code, message: `upstream failed with ${code}`, type, ...(plan === undefined ? {} : { plan }) };
  return {
    events: numbered([created(), { type: 'response.failed', sequence_number: 0, response: { ...base, error } }]),
  };
};

export const thrownStep = (message = 'gateway connection reset'): ScriptStep => ({ events: [], error: new Error(message) });

export const refusalStep = (refusal: string): ScriptStep =>
  outputStep([{ type: 'message', id: `msg_${nextResponseId()}`, status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal }] }]);

export const gated = (step: ScriptStep, afterEvents = 0): ScriptStep & { gate: NonNullable<ScriptStep['gate']> } => ({
  ...step,
  gate: { afterEvents, release: deferred<void>(), reached: deferred<void>() },
});
