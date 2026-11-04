import type { Capabilities, CreateResponseBody, InputItem, RunEventPayload } from '@momonga/protocol';
import { ERROR_WINDOW } from './token-meter.ts';
import type { MeterMemory, MeterMiss, MeterObservation, MeterReport } from './types.ts';

export type FoldedEvent = RunEventPayload & { runId?: string; seq?: number };

export type ObservedEvent = Extract<FoldedEvent, { type: 'meter.observed' }>;

export type MeterFoldOptions = {
  capabilities: Capabilities;
  fallbackTarget?: string;
  bodyOf?: (event: ObservedEvent) => unknown;
};

const isRequestBody = (body: unknown): body is CreateResponseBody =>
  typeof body === 'object' && body !== null && 'input' in body && Array.isArray(body.input);

const reportedRequestOf = (body: unknown): Pick<MeterReport, 'input' | 'tools'> => {
  if (!isRequestBody(body)) throw new Error('a meter.observed event has no model.requested with input items before it');
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

export const foldMeter = (events: readonly FoldedEvent[], { capabilities, fallbackTarget, bodyOf }: MeterFoldOptions): MeterMemory => {
  let requested: unknown;
  let latest: { event: ObservedEvent; body: unknown } | undefined;
  let misses: MeterMiss[] = [];
  for (const event of events) {
    if (event.type === 'model.requested') {
      requested = event.body;
      continue;
    }
    if (event.type !== 'meter.observed') continue;
    const routed = fallbackTarget === undefined ? !event.fallback : event.fallback && event.target === fallbackTarget;
    const current =
      event.contextWindow === capabilities.contextWindow &&
      event.tokenErrorRatio === capabilities.tokenErrorRatio &&
      event.tokenCounting === capabilities.tokenCounting;
    if (!routed || !current) continue;
    latest = { event, body: requested };
    misses = [...misses, { miss: event.miss, uncounted: event.uncounted }].slice(-ERROR_WINDOW);
  }
  if (latest === undefined) return { misses };
  const body = bodyOf === undefined ? latest.body : bodyOf(latest.event);
  return { latest: { observation: observationOf(latest.event), ...reportedRequestOf(body) }, misses };
};
