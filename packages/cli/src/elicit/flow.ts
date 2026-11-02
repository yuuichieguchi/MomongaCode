import type { ElicitationAnswerRecord, ElicitationRequestView } from '@momonga/protocol';
import { fieldsOf, parseFieldInput, validateContent } from './form.ts';
import type { ContentValue, FormField } from './form.ts';

export type ElicitationDecision = 'accept' | 'decline' | 'cancel';

export type ElicitationFlow = {
  readonly requests: readonly ElicitationRequestView[];
  readonly index: number;
  readonly stage: 'fields' | 'decision';
  readonly fields: readonly FormField[];
  readonly fieldIndex: number;
  readonly content: Readonly<Record<string, ContentValue>>;
  readonly answers: Readonly<Record<string, ElicitationAnswerRecord>>;
  readonly error: string | undefined;
  readonly complete: boolean;
};

const enter = (requests: readonly ElicitationRequestView[], index: number, answers: ElicitationFlow['answers']): ElicitationFlow => {
  const request = requests[index];
  if (request === undefined) throw new RangeError(`elicitation request ${index} does not exist`);
  const fields = request.mode === 'form' ? fieldsOf(request.requestedSchema) : [];
  return {
    requests,
    index,
    stage: fields.length === 0 ? 'decision' : 'fields',
    fields,
    fieldIndex: 0,
    content: {},
    answers,
    error: undefined,
    complete: false,
  };
};

export const startFlow = (requests: readonly ElicitationRequestView[]): ElicitationFlow => enter(requests, 0, {});

export const currentRequest = (flow: ElicitationFlow): ElicitationRequestView => {
  const request = flow.requests[flow.index];
  if (request === undefined) throw new RangeError(`elicitation request ${flow.index} does not exist`);
  return request;
};

export const currentField = (flow: ElicitationFlow): FormField | undefined => flow.fields[flow.fieldIndex];

export const enterValue = (flow: ElicitationFlow, text: string): ElicitationFlow => {
  const field = currentField(flow);
  if (flow.stage !== 'fields' || field === undefined) throw new Error('the elicitation is not asking for a field');
  const parsed = parseFieldInput(field, text);
  if (!parsed.ok) return { ...flow, error: parsed.error };
  const content = parsed.value === undefined ? flow.content : { ...flow.content, [field.name]: parsed.value };
  const last = flow.fieldIndex + 1 >= flow.fields.length;
  return { ...flow, content, error: undefined, ...(last ? { stage: 'decision' as const } : { fieldIndex: flow.fieldIndex + 1 }) };
};

export const leaveFields = (flow: ElicitationFlow): ElicitationFlow => ({ ...flow, stage: 'decision', error: undefined });

const answerFor = (flow: ElicitationFlow, decision: ElicitationDecision): ElicitationAnswerRecord | string => {
  if (decision !== 'accept') return { action: decision };
  const request = currentRequest(flow);
  if (request.mode === 'url') return { action: 'accept' };
  const invalid = validateContent(request.requestedSchema, flow.content);
  return invalid === undefined ? { action: 'accept', content: { ...flow.content } } : invalid;
};

export const decide = (flow: ElicitationFlow, decision: ElicitationDecision): ElicitationFlow => {
  if (flow.stage !== 'decision') throw new Error('the elicitation is not waiting for a decision');
  const answer = answerFor(flow, decision);
  if (typeof answer === 'string') {
    const missing = flow.fields.findIndex((field) => field.required && !(field.name in flow.content));
    return { ...flow, stage: flow.fields.length === 0 ? 'decision' : 'fields', fieldIndex: Math.max(0, missing), error: answer };
  }
  const request = currentRequest(flow);
  const answers = { ...flow.answers, [request.key]: answer };
  if (flow.index + 1 >= flow.requests.length) return { ...flow, answers, error: undefined, complete: true };
  return enter(flow.requests, flow.index + 1, answers);
};

export const withError = (flow: ElicitationFlow, error: string): ElicitationFlow => ({ ...flow, error });
