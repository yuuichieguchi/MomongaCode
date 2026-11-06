import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import type { Run } from '@momonga/store';
import * as thread from '../../src/memory/journal-thread.ts';
import { reflectionInputFor } from '../../src/memory/reflection-input.ts';
import { capabilitiesFor } from '../worker/harness.ts';
import { bash, fileTool } from './reflection-fixture.ts';

const RUN_ID = 'run-units';
const PROJECT = '/work/units';
const SHA = 'a'.repeat(64);
const STEPS = 2_000;
const EVENTS_TOUCHED_PER_UNIT = 2;

type Visit = (event: RunEvent) => void;
type VisitingReader = { visitRun(runId: string, types: readonly RunEvent['type'][], visit: Visit): Run };
type Handler = (request: Readonly<Record<string, unknown>>, progress: () => void) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
type HandlerFactory = (reader: VisitingReader) => Handler;

const factory = (name: string): HandlerFactory => {
  const found = (thread as Record<string, unknown>)[name];
  if (typeof found !== 'function') throw new Error(`journal-thread.ts does not export ${name}`);
  return found as HandlerFactory;
};

const journalOf = (payloads: readonly RunEventPayload[]): RunEvent[] =>
  payloads.map((payload, index) => ({ ...payload, id: index + 1, runId: RUN_ID, sessionId: 's', seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent);

type Trace = { units: number; maxTouchedBetweenUnits: number; visited: number };

const traced = async (events: readonly RunEvent[], status: Run['status'], name: string, request: Readonly<Record<string, unknown>>) => {
  const trace: Trace = { units: 0, maxTouchedBetweenUnits: 0, visited: 0 };
  let touched = new Set<number>();
  const unit = (): void => {
    trace.units += 1;
    trace.maxTouchedBetweenUnits = Math.max(trace.maxTouchedBetweenUnits, touched.size);
    touched = new Set();
  };
  const watched = events.map((event) => new Proxy(event, { get: (target, key, receiver) => (touched.add(target.seq), Reflect.get(target, key, receiver)) }));
  const run = { id: RUN_ID, sessionId: 's', status, lastSeq: events.length } as Run;
  const reader: VisitingReader = {
    visitRun: (runId, types, visit) => {
      expect(runId).toBe(RUN_ID);
      events.forEach((event, index) => {
        if (!types.includes(event.type)) return;
        trace.visited += 1;
        visit(watched[index] as RunEvent);
        unit();
      });
      return run;
    },
  };
  const reply = await factory(name)(reader)({ id: 1, kind: 'test', ...request }, () => undefined);
  unit();
  return { reply, trace };
};

const checks = (count: number): RunEventPayload[] => Array.from({ length: count }, (_unused, index) => bash(`t${index}`, 'npm test', 0, 'ok')).flat();

const lastCheckSeq = 3 + 3 * STEPS;

describe('each new handler touches a bounded number of events between two unit() calls (review of fd3c85df, finding 1)', () => {
  it('verdictHandler folds each event as it is visited, never the whole journal after the last unit', async () => {
    const events = journalOf([...fileTool('w1', 'Write', { path: `${PROJECT}/src/a.ts`, sha256: SHA, access: 'write' }), ...checks(STEPS)]);

    const { reply, trace } = await traced(events, 'COMPLETED', 'verdictHandler', { runId: RUN_ID, commands: ['npm test'], manifests: ['package.json'] });

    expect(reply).toEqual({
      lastSeq: events.length,
      verified: true,
      facts: [{ command: 'npm test', text: 'Run `npm test` to verify a change in this repository.', kind: 'procedure', check: { callId: `t${STEPS - 1}`, seq: lastCheckSeq }, manifestPaths: [] }],
    });
    expect(trace.visited).toBeGreaterThanOrEqual(3 * STEPS);
    expect(trace.maxTouchedBetweenUnits).toBeLessThanOrEqual(EVENTS_TOUCHED_PER_UNIT);
  });

  it('evidenceHandler finds the recorded hash and the latest check without a pass over the completed calls after the last unit', async () => {
    const events = journalOf([...fileTool('r1', 'Read', { path: `${PROJECT}/src/a.ts`, sha256: SHA, access: 'read' }), ...checks(STEPS)]);

    const { reply, trace } = await traced(events, 'COMPLETED', 'evidenceHandler', { runId: RUN_ID, paths: [`${PROJECT}/src/a.ts`], verificationCommands: ['npm test'] });

    expect(reply).toEqual({
      lastSeq: events.length,
      recorded: [{ sha256: SHA, seq: 3 }],
      check: { callId: `t${STEPS - 1}`, seq: lastCheckSeq, command: 'npm test', exitCode: 0 },
    });
    expect(trace.visited).toBeGreaterThanOrEqual(2 * STEPS);
    expect(trace.maxTouchedBetweenUnits).toBeLessThanOrEqual(EVENTS_TOUCHED_PER_UNIT);
  });

  it('reflectionInputHandler pairs each completion with its call as it is visited and builds the same input as today', async () => {
    const events = journalOf([{ type: 'user.message', text: 'fix the bug' }, ...checks(STEPS)]);
    const capabilities = capabilitiesFor(8_000);

    const { reply, trace } = await traced(events, 'COMPLETED', 'reflectionInputHandler', { runId: RUN_ID, project: PROJECT, capabilities });

    expect(reply).toEqual({ lastSeq: events.length, input: reflectionInputFor(events, PROJECT, capabilities) });
    expect(trace.visited).toBeGreaterThanOrEqual(2 * STEPS);
    expect(trace.maxTouchedBetweenUnits).toBeLessThanOrEqual(EVENTS_TOUCHED_PER_UNIT);
  });
});
