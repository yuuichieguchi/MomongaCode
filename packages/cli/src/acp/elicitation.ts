import { RequestError } from '@agentclientprotocol/sdk';
import type { CreateElicitationRequest, CreateElicitationResponse, ElicitationSchema } from '@agentclientprotocol/sdk';
import { isRecord } from '@momonga/foundation';
import type { ElicitationAnswerRecord, ElicitationRequestView } from '@momonga/protocol';

export type ElicitationScope = { readonly sessionId: string; readonly toolCallId: string; readonly inputId: string };

const schemaOf = (requestedSchema: Readonly<Record<string, unknown>>): ElicitationSchema => {
  const { type, properties, required } = requestedSchema;
  if (type !== undefined && type !== 'object') throw new Error(`an MCP elicitation asked for a schema of type ${JSON.stringify(type)}, but ACP elicitation forms are objects`);
  if (properties !== undefined && !isRecord(properties)) throw new Error('an MCP elicitation schema has properties that are not an object');
  if (required !== undefined && !(Array.isArray(required) && required.every((name) => typeof name === 'string'))) {
    throw new Error('an MCP elicitation schema has a required list that is not a list of names');
  }
  return requestedSchema as ElicitationSchema;
};

export const elicitationRequestOf = (scope: ElicitationScope, request: ElicitationRequestView): CreateElicitationRequest =>
  request.mode === 'form'
    ? { mode: 'form', sessionId: scope.sessionId, toolCallId: scope.toolCallId, message: request.message, requestedSchema: schemaOf(request.requestedSchema) }
    : {
        mode: 'url',
        sessionId: scope.sessionId,
        toolCallId: scope.toolCallId,
        message: request.message,
        elicitationId: `${scope.inputId}/${request.key}`,
        url: request.url,
      };

type AcceptedContent = Extract<ElicitationAnswerRecord, { action: 'accept' }>['content'] & object;

const isContentValue = (value: unknown): value is string | number | boolean | string[] =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));

const contentOf = (content: unknown): AcceptedContent => {
  if (!isRecord(content)) throw RequestError.invalidParams({ content }, 'the content of an accepted elicitation must be an object');
  const accepted: AcceptedContent = {};
  for (const [key, value] of Object.entries(content)) {
    if (!isContentValue(value)) throw RequestError.invalidParams({ key }, `the elicitation answer ${key} is not a string, a number, a boolean or a list of strings`);
    accepted[key] = value;
  }
  return accepted;
};

export const elicitationAnswerOf = (response: CreateElicitationResponse): ElicitationAnswerRecord => {
  switch (response.action) {
    case 'accept':
      return 'content' in response && response.content !== undefined && response.content !== null ? { action: 'accept', content: contentOf(response.content) } : { action: 'accept' };
    case 'decline':
      return { action: 'decline' };
    case 'cancel':
      return { action: 'cancel' };
    default:
      throw RequestError.invalidParams({ action: response.action }, `the client answered an elicitation with the unknown action ${response.action}`);
  }
};
