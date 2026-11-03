import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { isRecord } from '@momonga/foundation';
import { MEMORY_ORIGINS, REFLECTION_JOB_STATES, RUN_API_SCHEMAS, RUN_STATUSES, STOP_REASONS } from '@momonga/protocol';
import type { ContextChargeView, MemoryOrigin, PublicRunEvent, ReflectionJobState, RunStatus, StopReason } from '@momonga/protocol';

export const TRANSCRIPT_FORMAT = 'momonga-transcript/3';
const RETIRED_TRANSCRIPT_FORMATS: Readonly<Record<string, string>> = {
  'momonga-transcript/1': 'subagent runs',
  'momonga-transcript/2': 'the side effect of a tool call',
};

export type TranscriptRun = {
  id: string;
  status: RunStatus;
  stopReason?: StopReason;
  step: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  modelAlias?: string;
  origin?: MemoryOrigin;
};

export type TranscriptChild = { runId: string; agent: string; events: PublicRunEvent[] };

export type TranscriptReflection = { state: 'none' | ReflectionJobState; charges?: ContextChargeView[]; reason?: string };

export type Transcript = {
  caseId: string;
  runIndex: number;
  run: TranscriptRun;
  events: PublicRunEvent[];
  children: TranscriptChild[];
  reflection?: TranscriptReflection;
  ruleIds?: Record<string, string>;
  datasetSeed?: number;
  noiseTokens?: number;
  noiseReflectionsUnsettled?: number;
  stopped?: string;
};

export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptError';
  }
}

const ajv = new Ajv2020.default({ strict: false });
const validateEvent: ValidateFunction<PublicRunEvent> = ajv.compile<PublicRunEvent>(RUN_API_SCHEMAS.PublicRunEvent);

export const parsePublicRunEvent = (value: unknown, where: string): PublicRunEvent => {
  if (validateEvent(value)) return value;
  const first = validateEvent.errors?.[0];
  throw new TranscriptError(`${where}: not a public run event${first === undefined ? '' : ` (${first.instancePath || '/'}: ${first.message ?? 'schema violation'})`}`);
};


const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

const runOf = (value: unknown, where: string): TranscriptRun => {
  if (!isRecord(value)) throw new TranscriptError(`${where}: run must be an object`);
  const { id, status, stopReason, step, usage, modelAlias, origin } = value;
  if (origin !== undefined && (typeof origin !== 'string' || !(MEMORY_ORIGINS as readonly string[]).includes(origin))) throw new TranscriptError(`${where}: run.origin must be trusted or untrusted`);
  if (modelAlias !== undefined && (typeof modelAlias !== 'string' || modelAlias === '')) throw new TranscriptError(`${where}: run.modelAlias must be a non-empty string`);
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
    ...(modelAlias === undefined ? {} : { modelAlias }),
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

const validateReflectionView: ValidateFunction = ajv.compile(RUN_API_SCHEMAS.RunReflection);

const reflectionOf = (value: unknown, where: string): TranscriptReflection => {
  if (!isRecord(value)) throw new TranscriptError(`${where}: reflection must be an object`);
  const { state, charges, reason } = value;
  if (state !== 'none' && (typeof state !== 'string' || !(REFLECTION_JOB_STATES as readonly string[]).includes(state))) {
    throw new TranscriptError(`${where}: reflection.state must be none or a reflection job state`);
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason === '')) throw new TranscriptError(`${where}: reflection.reason must be a non-empty string`);
  if (charges !== undefined && !validateReflectionView({ job: null, charges, queuedAhead: 0 })) {
    throw new TranscriptError(`${where}: reflection.charges are not context charges: ${ajv.errorsText(validateReflectionView.errors, { dataVar: 'reflection' })}`);
  }
  return {
    state: state as TranscriptReflection['state'],
    ...(charges === undefined ? {} : { charges: charges as ContextChargeView[] }),
    ...(reason === undefined ? {} : { reason }),
  };
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
    parsed = line === undefined ? undefined : JSON.parse(line);
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
    header = JSON.parse(headerLine);
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
  const end = endRecordOf(eventLines.at(-1), source);
  const events: PublicRunEvent[] = [];
  eventLines.slice(0, -1).forEach((line, index) => {
    const lineNumber = index + 2;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
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
    ...(header['reflection'] === undefined ? {} : { reflection: reflectionOf(header['reflection'], `${source}:1`) }),
    ...liveFieldsOf(header, `${source}:1`),
  };
};
