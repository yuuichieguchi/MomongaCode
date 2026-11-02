import type { CountRange, GraderSpec, PermissionDecision } from './dataset.ts';
import { callsOf, finalTextOf } from './observe.ts';
import type { ObservedCall } from './observe.ts';
import type { Transcript } from './transcript.ts';

export type GradeOutcome =
  | { kind: 'pass'; grader: GraderSpec['kind']; detail: string }
  | { kind: 'fail'; grader: GraderSpec['kind']; detail: string };

export type DecisionObservation = {
  tool: string;
  expected: PermissionDecision;
  observed: PermissionDecision | 'not_called' | 'unresolved';
};

export type Graded = { outcomes: GradeOutcome[]; decisions: DecisionObservation[]; passed: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => key in right && deepEqual(left[key], right[key]));
  }
  return false;
};

const includesSubset = (actual: unknown, expected: Record<string, unknown>): boolean =>
  isRecord(actual) && Object.entries(expected).every(([key, value]) => key in actual && deepEqual(actual[key], value));

const inRange = (value: number, range: CountRange): boolean => (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);

const describeRange = (range: CountRange): string => `${range.min ?? 0}..${range.max ?? 'inf'}`;

const outcome = (spec: GraderSpec, passed: boolean, detail: string): GradeOutcome => ({ kind: passed ? 'pass' : 'fail', grader: spec.kind, detail });

const gradeToolCalled = (spec: Extract<GraderSpec, { kind: 'toolCalled' }>, calls: readonly ObservedCall[]): GradeOutcome => {
  const matching = calls.filter(
    (call) => call.name === spec.name && (spec.inputIncludes === undefined || includesSubset(call.rawInput, spec.inputIncludes)),
  );
  const range = spec.count ?? { min: 1 };
  return outcome(spec, inRange(matching.length, range), `${spec.name} called ${matching.length} time(s), expected ${describeRange(range)}`);
};

const gradeDecision = (spec: Extract<GraderSpec, { kind: 'permissionDecision' }>, calls: readonly ObservedCall[]): { outcome: GradeOutcome; observation: DecisionObservation } => {
  const called = calls.filter((call) => call.name === spec.tool);
  const first = called[0];
  const observed: DecisionObservation['observed'] = first === undefined ? 'not_called' : first.decision;
  const observation = { tool: spec.tool, expected: spec.expected, observed };
  return { outcome: outcome(spec, observed === spec.expected, `${spec.tool} decision ${observed}, expected ${spec.expected}`), observation };
};

const gradeOne = (spec: GraderSpec, transcript: Transcript, calls: readonly ObservedCall[]): GradeOutcome => {
  const { run, events } = transcript;
  switch (spec.kind) {
    case 'status':
      return outcome(spec, run.status === spec.equals, `status ${run.status}, expected ${spec.equals}`);
    case 'stopReason':
      return outcome(spec, run.stopReason === spec.equals, `stopReason ${run.stopReason ?? 'none'}, expected ${spec.equals}`);
    case 'noStopReason':
      return outcome(spec, run.stopReason === undefined, `stopReason ${run.stopReason ?? 'none'}, expected none`);
    case 'finalTextEquals': {
      const text = finalTextOf(events);
      return outcome(spec, text === spec.text, text === undefined ? 'the run produced no model response' : `final text ${JSON.stringify(text)}`);
    }
    case 'finalTextIncludes': {
      const text = finalTextOf(events);
      return outcome(spec, text?.includes(spec.text) === true, text === undefined ? 'the run produced no model response' : `final text ${JSON.stringify(text)}`);
    }
    case 'finalTextMatches': {
      const text = finalTextOf(events);
      return outcome(spec, text !== undefined && new RegExp(spec.pattern, 'u').test(text), text === undefined ? 'the run produced no model response' : `final text ${JSON.stringify(text)}`);
    }
    case 'toolCalled':
      return gradeToolCalled(spec, calls);
    case 'toolNotCalled': {
      const count = calls.filter((call) => call.name === spec.name).length;
      return outcome(spec, count === 0, `${spec.name} called ${count} time(s), expected 0`);
    }
    case 'stepsAtMost':
      return outcome(spec, run.step <= spec.max, `${run.step} step(s), at most ${spec.max}`);
    case 'tokensAtMost':
      return outcome(spec, run.usage.totalTokens <= spec.max, `${run.usage.totalTokens} token(s), at most ${spec.max}`);
    case 'permissionDecision':
      return gradeDecision(spec, calls).outcome;
  }
};

export const grade = (specs: readonly GraderSpec[], transcript: Transcript): Graded => {
  const calls = callsOf(transcript.events);
  const outcomes = specs.map((spec) => gradeOne(spec, transcript, calls));
  const decisions = specs.flatMap((spec) => (spec.kind === 'permissionDecision' ? [gradeDecision(spec, calls).observation] : []));
  return { outcomes, decisions, passed: outcomes.every((entry) => entry.kind === 'pass') };
};
