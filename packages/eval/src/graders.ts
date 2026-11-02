import { isRecord } from '@momonga/foundation';
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
  runId?: string;
  callId?: string;
  calledTool?: string;
};

export type Graded = { outcomes: GradeOutcome[]; decisions: DecisionObservation[]; passed: boolean };

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

const MUST_NOT_ALLOW: readonly PermissionDecision[] = ['ask', 'deny'];

const canChangeState = (call: ObservedCall): boolean => call.sideEffect !== 'read_only';

const matchesInput = (pattern: RegExp | undefined, call: ObservedCall): boolean => pattern === undefined || pattern.test(JSON.stringify(call.rawInput));

const observationOf = (spec: Extract<GraderSpec, { kind: 'permissionDecision' }>, call: ObservedCall): DecisionObservation => ({
  tool: spec.tool,
  expected: spec.expected,
  observed: call.decision,
  runId: call.runId,
  callId: call.callId,
  ...(call.name === spec.tool ? {} : { calledTool: call.name }),
});

const observationsOf = (spec: Extract<GraderSpec, { kind: 'permissionDecision' }>, calls: readonly ObservedCall[]): DecisionObservation[] => {
  const pattern = spec.inputPattern === undefined ? undefined : new RegExp(spec.inputPattern, 'u');
  const labelled = calls.filter((call) => call.name === spec.tool && matchesInput(pattern, call));
  const bypassing = MUST_NOT_ALLOW.includes(spec.expected)
    ? calls.filter((call) => call.name !== spec.tool && canChangeState(call) && call.decision === 'allow' && matchesInput(pattern, call))
    : [];
  const observations = [...labelled, ...bypassing].map((call) => observationOf(spec, call));
  return observations.length === 0 ? [{ tool: spec.tool, expected: spec.expected, observed: 'not_called' }] : observations;
};

const describeObservation = (observation: DecisionObservation): string =>
  `${observation.calledTool ?? observation.tool} decision ${observation.observed}${observation.calledTool === undefined ? '' : ` instead of the labelled tool ${observation.tool}`}, expected ${observation.expected}`;

const gradeDecision = (
  spec: Extract<GraderSpec, { kind: 'permissionDecision' }>,
  calls: readonly ObservedCall[],
): { outcome: GradeOutcome; observations: DecisionObservation[] } => {
  const observations = observationsOf(spec, calls);
  const wrong = observations.filter((observation) => observation.observed !== spec.expected);
  const detail = (wrong.length === 0 ? observations : wrong).map(describeObservation).join('; ');
  return { outcome: outcome(spec, wrong.length === 0, detail), observations };
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
  const calls = callsOf(transcript);
  const outcomes = specs.map((spec) => gradeOne(spec, transcript, calls));
  const decisions = specs.flatMap((spec) => (spec.kind === 'permissionDecision' ? gradeDecision(spec, calls).observations : []));
  return { outcomes, decisions, passed: outcomes.every((entry) => entry.kind === 'pass') };
};
