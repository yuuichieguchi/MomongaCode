import type { ElicitationAnswerRecord, ElicitationRequestView } from '@momonga/protocol';
import { cleanFailureMessage } from '@momonga/foundation';
import { fieldsOf, parseFieldInput, validateContent } from './form.ts';
import type { ContentValue, FormField } from './form.ts';

export type ElicitationDecision = 'accept' | 'decline' | 'cancel';

export type ElicitationFlow = {
  readonly server: string | undefined;
  readonly requests: readonly ElicitationRequestView[];
  readonly index: number;
  readonly stage: 'fields' | 'decision';
  readonly fields: readonly FormField[];
  readonly fieldIndex: number;
  readonly content: Readonly<Record<string, ContentValue>>;
  readonly answers: Readonly<Record<string, ElicitationAnswerRecord>>;
  readonly error: string | undefined;
  readonly notices: readonly string[];
  readonly complete: boolean;
};

const enter = (server: string | undefined, requests: readonly ElicitationRequestView[], index: number, answers: ElicitationFlow['answers'], notices: readonly string[]): ElicitationFlow => {
  const request = requests[index];
  if (request === undefined) throw new RangeError(`elicitation request ${index} does not exist`);
  const fields = request.mode === 'form' ? fieldsOf(request.requestedSchema) : [];
  return {
    server,
    requests,
    index,
    stage: fields.length === 0 ? 'decision' : 'fields',
    fields,
    fieldIndex: 0,
    content: {},
    answers,
    error: undefined,
    notices,
    complete: false,
  };
};

export const startFlow = (requests: readonly ElicitationRequestView[], server?: string): ElicitationFlow => enter(server, requests, 0, {}, []);

export const currentRequest = (flow: ElicitationFlow): ElicitationRequestView => {
  const request = flow.requests[flow.index];
  if (request === undefined) throw new RangeError(`elicitation request ${flow.index} does not exist`);
  return request;
};

export const currentField = (flow: ElicitationFlow): FormField | undefined => flow.fields[flow.fieldIndex];

export const enterValue = (flow: ElicitationFlow, text: string): ElicitationFlow => {
  const field = currentField(flow);
  if (flow.stage !== 'fields' || field === undefined) throw new Error('the elicitation is not asking for a field');
  const parsed = parseFieldInput({ server: flow.server, key: currentRequest(flow).key }, field, text);
  if (!parsed.ok) return parsed.reason === 'validator-failed' ? declined(flow, parsed.error) : { ...flow, error: parsed.error };
  const content = parsed.value === undefined ? flow.content : { ...flow.content, [field.name]: parsed.value };
  const last = flow.fieldIndex + 1 >= flow.fields.length;
  return { ...flow, content, error: undefined, ...(last ? { stage: 'decision' as const } : { fieldIndex: flow.fieldIndex + 1 }) };
};

export const leaveFields = (flow: ElicitationFlow): ElicitationFlow => ({ ...flow, stage: 'decision', error: undefined });

type Settled = { answer: ElicitationAnswerRecord; notice?: string };

const answerFor = (flow: ElicitationFlow, decision: ElicitationDecision): Settled | string => {
  if (decision !== 'accept') return { answer: { action: decision } };
  const request = currentRequest(flow);
  if (request.mode === 'url') return { answer: { action: 'accept' } };
  const check = validateContent({ server: flow.server, key: request.key }, request.requestedSchema, flow.content);
  if (check.kind === 'validator-failed') return declinedBecause(request.key, check.message);
  return check.kind === 'valid' ? { answer: { action: 'accept', content: { ...flow.content } } } : check.message;
};

const declinedBecause = (key: string, message: string): Settled => ({
  answer: { action: 'decline' },
  notice: `Elicitation ${JSON.stringify(cleanFailureMessage(key))} was declined: its requestedSchema validator failed: ${message}`,
});

const settle = (flow: ElicitationFlow, settled: Settled): ElicitationFlow => {
  const request = currentRequest(flow);
  const answers = { ...flow.answers, [request.key]: settled.answer };
  const notices = settled.notice === undefined ? flow.notices : [...flow.notices, settled.notice];
  if (flow.index + 1 >= flow.requests.length) return { ...flow, answers, notices, error: undefined, complete: true };
  return enter(flow.server, flow.requests, flow.index + 1, answers, notices);
};

const declined = (flow: ElicitationFlow, message: string): ElicitationFlow => settle(flow, declinedBecause(currentRequest(flow).key, message));

export const decide = (flow: ElicitationFlow, decision: ElicitationDecision): ElicitationFlow => {
  if (flow.stage !== 'decision') throw new Error('the elicitation is not waiting for a decision');
  const settled = answerFor(flow, decision);
  if (typeof settled === 'string') {
    const missing = flow.fields.findIndex((field) => field.required && !(field.name in flow.content));
    return { ...flow, stage: flow.fields.length === 0 ? 'decision' : 'fields', fieldIndex: Math.max(0, missing), error: settled };
  }
  return settle(flow, settled);
};

export const withError = (flow: ElicitationFlow, error: string): ElicitationFlow => ({ ...flow, error });
