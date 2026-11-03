import type { BreakdownCallInput, RunEvent, RunTraceCall } from '@momonga/protocol';

type Requested = Extract<RunEvent, { type: 'model.requested' }>;

export const traceCallsOf = (events: readonly RunEvent[]): RunTraceCall[] =>
  events
    .filter((event): event is Requested => event.type === 'model.requested')
    .map((event) => ({ step: event.step, attempt: event.attempt, ...(event.anatomy === undefined ? {} : { anatomy: event.anatomy }) }));

export const breakdownInputsOf = (runId: string, events: readonly RunEvent[]): BreakdownCallInput[] => {
  const requests = new Map<string, Requested>();
  const inputs: BreakdownCallInput[] = [];
  for (const event of events) {
    if (event.type === 'model.requested') {
      requests.set(`${event.step}:${event.attempt}`, event);
    } else if (event.type === 'model.responded') {
      const anatomy = requests.get(`${event.step}:${event.attempt}`)?.anatomy;
      inputs.push({
        runId,
        step: event.step,
        ...(anatomy === undefined ? {} : { anatomy }),
        ...(event.response.timing === undefined ? {} : { timing: event.response.timing }),
      });
    }
  }
  return inputs;
};
