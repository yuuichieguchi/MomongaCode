import type { RunEvent, RunEventPayload } from './run-types.ts';

export const EXECUTED_TEXT_EVENT_TYPES = [
  'tool.call',
  'tool.started',
  'tool.completed',
  'tool.reconciled',
  'tool.held.resolved',
  'verification.completed',
] as const satisfies readonly RunEventPayload['type'][];

export type ExecutedTextEventType = (typeof EXECUTED_TEXT_EVENT_TYPES)[number];

export type ExecutedTextEvent<Type extends ExecutedTextEventType = ExecutedTextEventType> = Extract<RunEvent, { type: Type }>;

export type ExecutedTextHandlers<Context = void> = { [Type in ExecutedTextEventType]: (event: ExecutedTextEvent<Type>, context: Context) => void };

const EXECUTED_TEXT_TYPES: readonly string[] = EXECUTED_TEXT_EVENT_TYPES;

const isExecutedText = (event: RunEvent): event is ExecutedTextEvent => EXECUTED_TEXT_TYPES.includes(event.type);

const handed = <Type extends ExecutedTextEventType, Context>(type: Type, event: ExecutedTextEvent<Type>, handlers: ExecutedTextHandlers<Context>, context: Context): void =>
  handlers[type](event, context);

export const readExecutedText = <Context>(event: RunEvent, handlers: ExecutedTextHandlers<Context>, context: Context): boolean => {
  if (!isExecutedText(event)) return false;
  handed(event.type, event, handlers, context);
  return true;
};
