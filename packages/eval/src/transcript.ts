import { defineProductSchema, isRecord, parseOutsideJson, productErrorsText } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { MEMORY_ORIGINS, REFLECTION_JOB_STATES, RUN_API_SCHEMAS, RUN_STATUSES, STOP_REASONS } from '@momonga/protocol';
import { validatePolicyOverlay } from './context-policy.ts';
import type { PolicyOverlay } from './context-policy.ts';
import type { ContextChargeView, MemoryOrigin, PublicRunEvent, ReflectionJobState, RunStatus, StopReason, Stored } from '@momonga/protocol';

export const TRANSCRIPT_FORMAT = 'momonga-transcript/8';
const RETIRED_TRANSCRIPT_FORMATS: Readonly<Record<string, string>> = {
  'momonga-transcript/1': 'subagent runs',
  'momonga-transcript/2': 'the side effect of a tool call',
  'momonga-transcript/3': 'the policy and the code digest of the run',
  'momonga-transcript/4': 'what answered the run (the answering targets and whether each is a model or a script)',
  'momonga-transcript/5': 'an answerer whose adapter and model are unknown (a paid answer that recorded no answering target)',
  'momonga-transcript/6': 'whether the upstream reported the cache reads of each call',
  'momonga-transcript/7': 'the model each session used (it was recorded as an alias name)',
};

export type TranscriptRun = {
  id: string;
  status: RunStatus;
  stopReason?: StopReason;
  step: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  model?: string;
  origin?: MemoryOrigin;
};

export const ANSWER_KINDS = ['model', 'script', 'unknown'] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

export type Answerer = { target: string; adapter?: string; upstreamModel?: string; answers: AnswerKind };

export type TranscriptChild = { runId: string; agent: string; events: PublicRunEvent[] };

export type TranscriptReflection = { state: 'none' | Stored<ReflectionJobState>; charges?: ContextChargeView[]; reason?: string };

export type Transcript = {
  caseId: string;
  runIndex: number;
  run: TranscriptRun;
  events: PublicRunEvent[];
  children: TranscriptChild[];
  policy: PolicyOverlay | null;
  codeDigest: string | null;
  answeredBy?: Answerer[];
  reflection?: TranscriptReflection;
  ruleIds?: Record<string, string>;
  datasetSeed?: number;
  noiseTokens?: number;
  noiseReflectionsUnsettled?: number;
  stopped?: string;
};

export type RecordedRun = Omit<Transcript, 'policy' | 'codeDigest'>;

export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptError';
  }
}

const validateEvent: ProductValidator<PublicRunEvent> = defineProductSchema('run-api/PublicRunEvent', RUN_API_SCHEMAS.PublicRunEvent);

export const parsePublicRunEvent = (value: unknown, where: string): PublicRunEvent => {
  const verdict = validateEvent(value);
  if (verdict.valid) return verdict.value;
  const first = verdict.errors[0];
  throw new TranscriptError(`${where}: not a public run event${first === undefined ? '' : ` (${first.instancePath || '/'}: ${first.message})`}`);
};


const CODE_DIGEST = /^[0-9a-f]{64}$/;

const policyOf = (value: unknown, where: string): PolicyOverlay | null => {
  if (value === null) return null;
  const verdict = validatePolicyOverlay(value);
  if (!verdict.valid) throw new TranscriptError(`${where}: policy must be a token policy overlay`);
  return verdict.value;
};

const codeDigestOf = (value: unknown, where: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !CODE_DIGEST.test(value)) throw new TranscriptError(`${where}: codeDigest must be a sha256 hex digest`);
  return value;
};

const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

const runOf = (value: unknown, where: string): TranscriptRun => {
  if (!isRecord(value)) throw new TranscriptError(`${where}: run must be an object`);
  const { id, status, stopReason, step, usage, model, origin } = value;
  if (origin !== undefined && (typeof origin !== 'string' || !(MEMORY_ORIGINS as readonly string[]).includes(origin))) throw new TranscriptError(`${where}: run.origin must be trusted or untrusted`);
  if (model !== undefined && (typeof model !== 'string' || model === '')) throw new TranscriptError(`${where}: run.model must be a non-empty string`);
  if (typeof id !== 'string' || id === '') throw new TranscriptError(`${where}: run.id must be a non-empty string`);
  if (typeof status !== 'string' || !(RUN_STATUSES as readonly string[]).includes(status)) throw new TranscriptError(`${where}: run.status is not a run status`);
  if (stopReason !== undefined && (typeof stopReason !== 'string' || !(STOP_REASONS as readonly string[]).includes(stopReason))) {
    throw new TranscriptError(`${where}: run.stopReason is not a stop reason`);
  }
  if (!isNonNegativeInteger(step)) throw new TranscriptError(`${where}: run.step must be a non-negative integer`);
  if (!isRecord(usage) || !isNonNegativeInteger(usage['inputTokens']) || !isNonNegativeInteger(usage['outputTokens']) || !isNonNegativeInteger(usage['totalTokens'])) {
    throw new TranscriptError(`${where}: run.usage must hold non-negative integer inputTokens, outputTokens and totalTokens`);
  }
  return {
    id,
    status: status as RunStatus,
    ...(stopReason === undefined ? {} : { stopReason: stopReason as StopReason }),
    step,
    usage: { inputTokens: usage['inputTokens'], outputTokens: usage['outputTokens'], totalTokens: usage['totalTokens'] },
    ...(model === undefined ? {} : { model }),
    ...(origin === undefined ? {} : { origin: origin as MemoryOrigin }),
  };
};

const childrenOf = (value: unknown, where: string): TranscriptChild[] => {
  if (!Array.isArray(value)) throw new TranscriptError(`${where}: children must be a list`);
  return value.map((entry): TranscriptChild => {
    if (!isRecord(entry) || typeof entry['runId'] !== 'string' || typeof entry['agent'] !== 'string') throw new TranscriptError(`${where}: every child needs a runId and an agent`);
    return { runId: entry['runId'], agent: entry['agent'], events: [] };
  });
};

type LiveFields = Pick<Transcript, 'ruleIds' | 'datasetSeed' | 'noiseTokens' | 'noiseReflectionsUnsettled' | 'stopped'>;

const validateReflectionView: ProductValidator<unknown> = defineProductSchema('run-api/RunReflection', RUN_API_SCHEMAS.RunReflection);

const reflectionOf = (value: unknown, where: string): TranscriptReflection => {
  if (!isRecord(value)) throw new TranscriptError(`${where}: reflection must be an object`);
  const { state, charges, reason } = value;
  if (state !== 'none' && (typeof state !== 'string' || !(REFLECTION_JOB_STATES as readonly string[]).includes(state))) {
    throw new TranscriptError(`${where}: reflection.state must be none or a reflection job state`);
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason === '')) throw new TranscriptError(`${where}: reflection.reason must be a non-empty string`);
  const chargesVerdict = charges === undefined ? undefined : validateReflectionView({ job: null, charges, queuedAhead: 0 });
  if (chargesVerdict !== undefined && !chargesVerdict.valid) {
    throw new TranscriptError(`${where}: reflection.charges are not context charges: ${productErrorsText(chargesVerdict.errors, 'reflection')}`);
  }
  return {
    state: state as TranscriptReflection['state'],
    ...(charges === undefined ? {} : { charges: charges as ContextChargeView[] }),
    ...(reason === undefined ? {} : { reason }),
  };
};

const answeredByOf = (value: unknown, where: string): Answerer[] => {
  if (!Array.isArray(value)) throw new TranscriptError(`${where}: answeredBy must be a list`);
  return value.map((entry): Answerer => {
    if (
      !isRecord(entry) ||
      typeof entry['target'] !== 'string' ||
      entry['target'] === '' ||
      (entry['adapter'] !== undefined && typeof entry['adapter'] !== 'string') ||
      (entry['upstreamModel'] !== undefined && typeof entry['upstreamModel'] !== 'string') ||
      typeof entry['answers'] !== 'string' ||
      !(ANSWER_KINDS as readonly string[]).includes(entry['answers'])
    ) {
      throw new TranscriptError(`${where}: every answeredBy entry needs a target and answers model, script or unknown, and its adapter and upstreamModel, when present, are strings`);
    }
    const { target, adapter, upstreamModel, answers } = entry;
    return {
      target,
      ...(typeof adapter === 'string' ? { adapter } : {}),
      ...(typeof upstreamModel === 'string' ? { upstreamModel } : {}),
      answers: answers as AnswerKind,
    };
  });
};

const ruleIdsOf = (value: unknown, where: string): Record<string, string> => {
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new TranscriptError(`${where}: ruleIds must map product rule ids to dataset rule ids`);
  }
  return value as Record<string, string>;
};

const liveFieldsOf = (header: Record<string, unknown>, where: string): LiveFields => {
  const { ruleIds, datasetSeed, noiseTokens, noiseReflectionsUnsettled, stopped } = header;
  if (noiseReflectionsUnsettled !== undefined && !isNonNegativeInteger(noiseReflectionsUnsettled)) {
    throw new TranscriptError(`${where}: noiseReflectionsUnsettled must be a non-negative integer`);
  }
  if (datasetSeed !== undefined && !isNonNegativeInteger(datasetSeed)) throw new TranscriptError(`${where}: datasetSeed must be a non-negative integer`);
  if (noiseTokens !== undefined && !isNonNegativeInteger(noiseTokens)) throw new TranscriptError(`${where}: noiseTokens must be a non-negative integer`);
  if (stopped !== undefined && (typeof stopped !== 'string' || stopped === '')) throw new TranscriptError(`${where}: stopped must be a non-empty string`);
  return {
    ...(ruleIds === undefined ? {} : { ruleIds: ruleIdsOf(ruleIds, where) }),
    ...(datasetSeed === undefined ? {} : { datasetSeed }),
    ...(noiseTokens === undefined ? {} : { noiseTokens }),
    ...(noiseReflectionsUnsettled === undefined ? {} : { noiseReflectionsUnsettled }),
    ...(stopped === undefined ? {} : { stopped }),
  };
};

export const encodeTranscript = (transcript: Transcript): string => {
  const header = {
    format: TRANSCRIPT_FORMAT,
    caseId: transcript.caseId,
    runIndex: transcript.runIndex,
    run: transcript.run,
    children: transcript.children.map(({ runId, agent }) => ({ runId, agent })),
    policy: transcript.policy,
    codeDigest: transcript.codeDigest,
    ...(transcript.answeredBy === undefined ? {} : { answeredBy: transcript.answeredBy }),
    ...(transcript.reflection === undefined ? {} : { reflection: transcript.reflection }),
    ...(transcript.ruleIds === undefined ? {} : { ruleIds: transcript.ruleIds }),
    ...(transcript.datasetSeed === undefined ? {} : { datasetSeed: transcript.datasetSeed }),
    ...(transcript.noiseTokens === undefined ? {} : { noiseTokens: transcript.noiseTokens }),
    ...(transcript.noiseReflectionsUnsettled === undefined ? {} : { noiseReflectionsUnsettled: transcript.noiseReflectionsUnsettled }),
    ...(transcript.stopped === undefined ? {} : { stopped: transcript.stopped }),
  };
  const childLines = transcript.children.flatMap((child) => child.events.map((event) => ({ childRunId: child.runId, event })));
  const end = { end: true, events: transcript.events.length, childEvents: childLines.length };
  return [header, ...transcript.events, ...childLines, end].map((line) => JSON.stringify(line)).join('\n') + '\n';
};

const endRecordOf = (line: string | undefined, source: string): { events: number; childEvents: number } => {
  let parsed: unknown;
  try {
    parsed = line === undefined ? undefined : parseOutsideJson(line);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed) || parsed['end'] !== true || !isNonNegativeInteger(parsed['events']) || !isNonNegativeInteger(parsed['childEvents'])) {
    throw new TranscriptError(`${source}: the transcript has no end record, so it may have been cut short`);
  }
  return { events: parsed['events'], childEvents: parsed['childEvents'] };
};

export const decodeTranscript = (text: string, source: string): Transcript => {
  const lines = text.split('\n').filter((line) => line !== '');
  const [headerLine, ...eventLines] = lines;
  if (headerLine === undefined) throw new TranscriptError(`${source}: empty transcript`);
  let header: unknown;
  try {
    header = parseOutsideJson(headerLine);
  } catch (error) {
    throw new TranscriptError(`${source}:1: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isRecord(header) && typeof header['format'] === 'string' && Object.hasOwn(RETIRED_TRANSCRIPT_FORMATS, header['format'])) {
    throw new TranscriptError(`${source}:1: ${header['format']} transcripts do not record ${RETIRED_TRANSCRIPT_FORMATS[header['format']]}, so they cannot be graded as ${TRANSCRIPT_FORMAT}; record the case again`);
  }
  if (!isRecord(header) || header['format'] !== TRANSCRIPT_FORMAT) throw new TranscriptError(`${source}:1: first line must be a ${TRANSCRIPT_FORMAT} header`);
  const { caseId, runIndex } = header;
  if (typeof caseId !== 'string' || caseId === '') throw new TranscriptError(`${source}:1: caseId must be a non-empty string`);
  if (!isNonNegativeInteger(runIndex)) throw new TranscriptError(`${source}:1: runIndex must be a non-negative integer`);
  const run = runOf(header['run'], `${source}:1`);
  const children = childrenOf(header['children'], `${source}:1`);
  const policy = policyOf(header['policy'], `${source}:1`);
  const codeDigest = codeDigestOf(header['codeDigest'], `${source}:1`);
  if ((policy === null) !== (codeDigest === null)) throw new TranscriptError(`${source}:1: policy and codeDigest are both null or both recorded`);
  const end = endRecordOf(eventLines.at(-1), source);
  const events: PublicRunEvent[] = [];
  eventLines.slice(0, -1).forEach((line, index) => {
    const lineNumber = index + 2;
    let parsed: unknown;
    try {
      parsed = parseOutsideJson(line);
    } catch (error) {
      throw new TranscriptError(`${source}:${lineNumber}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isRecord(parsed) && 'childRunId' in parsed) {
      const child = children.find((entry) => entry.runId === parsed['childRunId']);
      if (child === undefined) throw new TranscriptError(`${source}:${lineNumber}: the event belongs to a child run the header does not list`);
      child.events.push(parsePublicRunEvent(parsed['event'], `${source}:${lineNumber}`));
      return;
    }
    events.push(parsePublicRunEvent(parsed, `${source}:${lineNumber}`));
  });
  const childEvents = children.reduce((sum, child) => sum + child.events.length, 0);
  if (events.length !== end.events || childEvents !== end.childEvents) {
    throw new TranscriptError(`${source}: the end record counts ${end.events} run events and ${end.childEvents} child events but the file holds ${events.length} and ${childEvents}`);
  }
  return {
    caseId,
    runIndex,
    run,
    events,
    children,
    policy,
    codeDigest,
    ...(header['answeredBy'] === undefined ? {} : { answeredBy: answeredByOf(header['answeredBy'], `${source}:1`) }),
    ...(header['reflection'] === undefined ? {} : { reflection: reflectionOf(header['reflection'], `${source}:1`) }),
    ...liveFieldsOf(header, `${source}:1`),
  };
};
