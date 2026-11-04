import type { Capabilities, CreateResponseBody, InputItem, RunEventPayload } from '@momonga/protocol';
import { ERROR_WINDOW } from './token-meter.ts';
import type { MeterMemory, MeterMiss, MeterObservation, MeterReport } from './types.ts';

export type FoldedEvent = RunEventPayload & { runId?: string; seq?: number };

export type ObservedEvent = Extract<FoldedEvent, { type: 'meter.observed' }>;

export type MeterFoldOptions = {
  counter: string;
  capabilities: Capabilities;
  bodyOf: (event: ObservedEvent) => unknown;
};

const isRequestBody = (body: unknown): body is CreateResponseBody =>
  typeof body === 'object' && body !== null && 'input' in body && Array.isArray(body.input);

const reportedRequestOf = (body: unknown): Pick<MeterReport, 'input' | 'tools'> => {
  if (!isRequestBody(body)) throw new Error('the request behind a meter.observed event carries no input items');
  return { input: body.input as InputItem[], tools: body.tools ?? [] };
};

const observationOf = (event: ObservedEvent): MeterObservation => ({
  inputDigest: event.inputDigest,
  itemCount: event.itemCount,
  counted: event.counted,
  reported: event.reported,
  kept: event.kept,
  known: event.known,
  uncounted: event.uncounted,
  miss: event.miss,
  contextWindow: event.contextWindow,
  ...(event.tokenErrorRatio === undefined ? {} : { tokenErrorRatio: event.tokenErrorRatio }),
  tokenCounting: event.tokenCounting,
});

export const foldMeter = (events: readonly FoldedEvent[], { counter, capabilities, bodyOf }: MeterFoldOptions): MeterMemory => {
  let latest: ObservedEvent | undefined;
  let misses: MeterMiss[] = [];
  for (const event of events) {
    if (event.type !== 'meter.observed') continue;
    const current =
      event.counter === counter &&
      event.contextWindow === capabilities.contextWindow &&
      event.tokenErrorRatio === capabilities.tokenErrorRatio &&
      event.tokenCounting === capabilities.tokenCounting;
    if (!current) continue;
    latest = event;
    misses = [...misses, { miss: event.miss, uncounted: event.uncounted }].slice(-ERROR_WINDOW);
  }
  if (latest === undefined) return { misses };
  return { latest: { observation: observationOf(latest), ...reportedRequestOf(bodyOf(latest)) }, misses };
};
