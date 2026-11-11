import type { DatabaseSync } from 'node:sqlite';
import { readTx } from '@momonga/foundation/sqlite';
import { ESTIMATED_CHARACTERS_PER_TOKEN, ESTIMATED_ERROR, TERMINAL_STATUSES, floorRatio, tokensForText } from '@momonga/protocol';
import type { ContentPart, InheritedReferencePayload, InheritedViaLink, InputItem, PermissionMode, RunEvent, RunState, RunStatus, TerminalStatus } from '@momonga/protocol';
import { decodeContextOf, decodeRun, decodeRunEvents } from './codec.ts';
import { createDerivedSnapshot } from './derived-repair.ts';
import { isFatalStoreError } from './fatal.ts';
import { foldRunState, initialRunState } from './fold.ts';
import { ITEM_EVENT_TYPES, itemsOfEvent } from './history-items.ts';
import type { ItemFacts } from './history-items.ts';
import { InheritanceError, isReferenceInherited, projectReference, rebaseOntoReference, referenceDigest, retractsTask, signReference } from './inherit.ts';
import type { InheritanceOutcome, UnaskedCommands } from './inherit.ts';
import { createRecordWalker } from './record-walk.ts';
import type { RecordVisit, WalkUnits } from './record-walk.ts';
import { knownValue } from './rows.ts';
import type { Row } from './rows.ts';
import type { Run } from './types.ts';

export const INHERIT_RANGE_ROWS = 1000;

export type HistoryEntry = RunState['history'][number];

export type EvictedStub = { seq: number; callId: string; handle: string; tokens: number };

export type WindowEntry = HistoryEntry | EvictedStub;

export type InheritedWindowRequest = { runId: string; windowTokens: number; floorTokens: number };

export type InheritedWindowReply = {
  lastSeq: number;
  summary?: NonNullable<RunState['summary']>;
  entries: WindowEntry[];
  evicted: string[];
  omittedOlder: boolean;
};

export type InheritPlanRequest = { runId: string; mode: PermissionMode; unasked: UnaskedCommands };

export type InheritWalked = { runId: string; lastSeq: number; status: RunStatus };

export type InheritPlanReply =
  | { kind: 'ready'; payload: InheritedReferencePayload; walked: InheritWalked[] }
  | { kind: 'none' }
  | { kind: 'already' }
  | { kind: 'conflict'; reason: string };

export type RetainedHistory = { entries: HistoryEntry[]; summary?: NonNullable<RunState['summary']>; evicted: string[] };

export type ReferenceHooks = {
  unit: () => void;
  stepped: (rows: number) => void;
  onDecode?: (rows: number, bytes: number) => void;
  onHop?: (runId: string) => void;
};

export type RecordFault = { runId: string; reason: string };

export type RecordHopRef = { runId: string; bound: number; omitsTask: boolean };

export type RecordWalkRequest = {
  reference: InheritedReferencePayload & RunEvent;
  types: readonly RunEvent['type'][];
  visit: RecordVisit;
  units: WalkUnits;
  onFault: (fault: RecordFault) => void;
  cover: (hop: RecordHopRef) => number | undefined;
};

export type ReferenceReader = {
  visitRecord(request: RecordWalkRequest): Promise<void>;
  planInheritance(request: InheritPlanRequest): InheritPlanReply;
  readInheritedWindow(request: InheritedWindowRequest): InheritedWindowReply;
  retainedOf(reference: InheritedReferencePayload & { type: 'context.inherited' }): RetainedHistory;
};

type Truncation = { callId: string; handle: string; kind: 'omitted' | 'truncated' | 'reference'; tokens?: number };

type Rejection = { runId: string; seq: number; item: NonNullable<RunState['summary']>['item'] };

type CompactionPoint = NonNullable<RunState['summary']>;

type WalkContext = {
  floor: number;
  pointer: { runId: string; eventSeq: number } | undefined;
  visitedPointerRun: boolean;
  truncations: Truncation[];
  rejections: Rejection[];
  oldEvicted: Set<string>;
};

const WALKED_EVENT_TYPES = [...ITEM_EVENT_TYPES, 'context.truncated', 'context.compaction_rejected'] as const;

const TERMINAL_STATUS_LIST: readonly string[] = TERMINAL_STATUSES;

const FOLD_EVENT_COLUMNS = `e.id, e.run_id, e.session_id, e.seq, e.step, e.lease_token, e.created_at, e.type,
  CASE WHEN e.type = 'model.requested' THEN json_object(
    'type', 'model.requested',
    'step', json_extract(e.payload_json, '$.step'),
    'attempt', json_extract(e.payload_json, '$.attempt'),
    'digest', json_extract(e.payload_json, '$.digest'),
    'body', json_object('tool_choice', json_extract(e.payload_json, '$.body.tool_choice'))
  ) ELSE e.payload_json END AS payload_json`;

const inconsistent = (detail: string): InheritanceError => new InheritanceError('previous_run_inconsistent', detail);

const isTerminalStatus = (status: RunStatus): status is TerminalStatus => TERMINAL_STATUS_LIST.includes(status);

const discountedFloor = (tokens: number): number => floorRatio({ num: ESTIMATED_ERROR.den, den: ESTIMATED_ERROR.den + ESTIMATED_ERROR.num }, tokens);

const partChars = (part: ContentPart): number => {
  if ('text' in part) return part.text.length;
  if ('refusal' in part) return part.refusal.length;
  return 0;
};

const contentChars = (content: string | readonly ContentPart[] | null | undefined): number =>
  content === undefined || content === null ? 0 : typeof content === 'string' ? content.length : content.reduce((sum, part) => sum + partChars(part), 0);

const charsOf = (item: InputItem): number => {
  switch (item.type) {
    case 'message':
      return contentChars(item.content);
    case 'function_call':
      return item.name.length + 1 + item.arguments.length;
    case 'reasoning':
      return contentChars(item.summary) + contentChars(item.content);
    case 'function_call_output':
    case 'compaction':
      return 0;
  }
};

const outputTextOf = (output: string | readonly ContentPart[]): string => (typeof output === 'string' ? output : output.map((part) => ('text' in part ? part.text : '')).join(''));

export const lowerBoundTokens = (item: InputItem, floorTokens: number): number =>
  item.type === 'function_call_output'
    ? Math.max(1, Math.min(floorTokens, discountedFloor(tokensForText(outputTextOf(item.output)))))
    : Math.max(1, discountedFloor(Math.ceil(charsOf(item) / ESTIMATED_CHARACTERS_PER_TOKEN)));

const isStub = (entry: WindowEntry): entry is EvictedStub => !('item' in entry);

const outputCallIdOf = (entry: WindowEntry): string | undefined => {
  if (isStub(entry)) return entry.callId;
  return entry.item.type === 'function_call_output' ? entry.item.call_id : undefined;
};

export const createReferenceReader = (db: DatabaseSync, hooks: ReferenceHooks): ReferenceReader => {
  const { unit, stepped } = hooks;
  const selectRun = db.prepare('SELECT * FROM runs WHERE id = :id');
  const firstInherited = db.prepare("SELECT * FROM events WHERE run_id = :runId AND type = 'context.inherited' ORDER BY seq LIMIT 1");
  const eventAt = db.prepare('SELECT * FROM events WHERE run_id = :runId AND seq = :seq');
  const itemRows = db.prepare(
    `SELECT * FROM events INDEXED BY events_by_run_type WHERE run_id = :runId AND type IN (${WALKED_EVENT_TYPES.map((type) => `'${type}'`).join(', ')}) AND seq >= :from AND seq <= :to ORDER BY seq DESC`,
  );
  const callName = db.prepare("SELECT tool_name FROM events INDEXED BY events_by_run_type WHERE run_id = :runId AND type = 'tool.call' AND call_id = :callId ORDER BY seq");
  const itemFactsOf = (runId: string): ItemFacts => ({
    providerCallIdOf: (callId) => callId,
    heldToolNameOf: (callId) => {
      const row = callName.get({ runId, callId });
      const name = row?.['tool_name'];
      if (typeof name !== 'string') throw inconsistent(`run ${runId}: the held call ${callId} has no tool.call record that names its tool`);
      return name;
    },
  });
  const firstTask = db.prepare("SELECT * FROM events WHERE run_id = :runId AND type = 'user.message' AND seq <= :bound ORDER BY seq LIMIT 1");
  const latestCompacted = db.prepare("SELECT * FROM events WHERE run_id = :runId AND type = 'context.compacted' AND seq <= :bound ORDER BY seq DESC LIMIT 1");
  const derived = createDerivedSnapshot(db);
  const recordedTokens = db.prepare(
    `SELECT json_extract(payload_json, '$.tokens') AS tokens FROM events
     WHERE run_id = :runId AND type = 'context.truncated' AND json_extract(payload_json, '$.callId') = :callId
       AND json_extract(payload_json, '$.kind') = 'omitted' AND json_extract(payload_json, '$.tokens') IS NOT NULL
     ORDER BY seq DESC LIMIT 1`,
  );
  const walker = createRecordWalker(db, { unit, stepped, ...(hooks.onDecode === undefined ? {} : { onDecode: hooks.onDecode }) });
  const foldRows = db.prepare(`SELECT ${FOLD_EVENT_COLUMNS} FROM events e WHERE e.run_id = :runId AND e.seq >= :from AND e.seq < :until ORDER BY e.seq`);

  const decodeContext = decodeContextOf(db);

  const decodeKnown = (row: Row): RunEvent[] => {
    hooks.onDecode?.(1, typeof row['payload_json'] === 'string' ? Buffer.byteLength(row['payload_json']) : 0);
    const events = decodeRunEvents([row], decodeContext);
    unit();
    return events;
  };

  const decode = (row: Row): RunEvent => {
    const [event] = decodeKnown(row);
    if (event === undefined) throw new Error('a row of a requested known type did not decode to an event');
    return event;
  };

  const loadRun = (runId: string): Run => {
    const row = selectRun.get({ id: runId });
    if (row === undefined) throw new Error(`unknown run ${runId}`);
    return decodeRun(row, decodeContext);
  };

  const inheritedEventOf = (runId: string): (RunEvent & { type: 'context.inherited' }) | undefined => {
    const row = firstInherited.get({ runId });
    if (row === undefined) return undefined;
    const event = decode(row);
    if (event.type !== 'context.inherited') throw inconsistent(`run ${runId}: the context.inherited row did not decode to a context.inherited event`);
    if (isReferenceInherited(event) && referenceDigest(event) !== event.digest) throw inconsistent(`run ${runId}: context.inherited digest does not match its content`);
    return event;
  };

  const referenceOf = (event: RunEvent & { type: 'context.inherited' }): (InheritedReferencePayload & RunEvent) | undefined =>
    isReferenceInherited(event) ? event : undefined;

  function* ownItems(context: WalkContext, runId: string, bound: number, nextItemSeq: number, taskSeq: () => number): Generator<HistoryEntry> {
    let top = nextItemSeq - 1;
    for (let to = bound; to >= 1; to -= INHERIT_RANGE_ROWS) {
      const from = Math.max(1, to - INHERIT_RANGE_ROWS + 1);
      const rows = itemRows.all({ runId, from, to });
      stepped(to - from + 1);
      unit();
      for (const row of rows) {
        const event = decode(row);
        if (event.type === 'context.truncated') {
          context.truncations.push({ callId: event.callId, handle: event.handle, kind: event.kind, ...(event.tokens === undefined ? {} : { tokens: event.tokens }) });
          continue;
        }
        if (event.type === 'context.compaction_rejected') {
          const { pointer } = context;
          const valid = pointer === undefined || !(context.visitedPointerRun && runId !== pointer.runId);
          const afterPointer = pointer === undefined || runId !== pointer.runId || event.seq > pointer.eventSeq;
          if (valid && afterPointer) context.rejections.push({ runId, seq: event.seq, item: event.item });
          continue;
        }
        const produced = itemsOfEvent(event, itemFactsOf(runId));
        for (let index = produced.length - 1; index >= 0; index -= 1) {
          const { item, callId, handle } = produced[index] as (typeof produced)[number];
          yield { seq: top, item, ...(callId === undefined ? {} : { callId }), ...(handle === undefined ? {} : { handle }) };
          top -= 1;
        }
      }
    }
    if (top !== taskSeq() - 1) throw inconsistent(`run ${runId}: its records number items down to ${top + 1}, not to its task at seq ${taskSeq()}`);
  }

  function* mergeDescending(synthesised: readonly HistoryEntry[], lowerMax: number, lower: Generator<HistoryEntry>): Generator<HistoryEntry> {
    const ordered = [...synthesised].sort((a, b) => b.seq - a.seq);
    let at = 0;
    while (at < ordered.length && (ordered[at] as HistoryEntry).seq > lowerMax) {
      yield ordered[at] as HistoryEntry;
      at += 1;
    }
    let next = lower.next();
    while (at < ordered.length || !next.done) {
      const head = ordered[at];
      if (next.done) {
        yield head as HistoryEntry;
        at += 1;
      } else if (head !== undefined && head.seq > next.value.seq) {
        yield head;
        at += 1;
      } else {
        if (head !== undefined && head.seq === next.value.seq) throw inconsistent(`two items claim seq ${head.seq}`);
        yield next.value;
        next = lower.next();
      }
    }
  }

  function* omitting(lower: Generator<HistoryEntry>, omitSeqs: readonly number[]): Generator<HistoryEntry> {
    for (const entry of lower) if (!omitSeqs.includes(entry.seq)) yield entry;
  }

  function* viaStage(context: WalkContext, link: InheritedViaLink, previousTop: number, lower: Generator<HistoryEntry>): Generator<HistoryEntry> {
    hooks.onHop?.(link.runId);
    const row = firstTask.get({ runId: link.runId, bound: link.lastSeq });
    if (row === undefined) throw inconsistent(`run ${link.runId}: its task record is missing`);
    const [entry] = itemsOfEvent(decode(row), itemFactsOf(link.runId));
    if (entry === undefined) throw inconsistent(`run ${link.runId}: its first user.message produced no item`);
    yield { seq: link.nextItemSeq, item: entry.item };
    yield* mergeDescending(link.synthesised, previousTop, omitting(lower, link.omitSeqs));
  }

  function* streamOfRun(context: WalkContext, runId: string, bound: number, nextItemSeq: number): Generator<HistoryEntry> {
    if (nextItemSeq - 1 <= context.floor) return;
    hooks.onHop?.(runId);
    if (context.pointer?.runId === runId) context.visitedPointerRun = true;
    let loaded: { event: (RunEvent & { type: 'context.inherited' }) | undefined } | undefined;
    const load = (): (RunEvent & { type: 'context.inherited' }) | undefined => {
      loaded ??= { event: inheritedEventOf(runId) };
      return loaded.event;
    };
    yield* ownItems(context, runId, bound, nextItemSeq, () => load()?.nextItemSeq ?? 1);
    const event = load();
    if (event === undefined || event.nextItemSeq - 1 <= context.floor) return;
    if (isReferenceInherited(event)) {
      yield* streamOfReference(context, event);
      return;
    }
    for (const id of event.evicted) context.oldEvicted.add(id);
    yield* [...event.history].reverse();
  }

  function* streamOfReference(context: WalkContext, reference: InheritedReferencePayload): Generator<HistoryEntry> {
    let lower = streamOfRun(context, reference.fromRunId, reference.fromLastSeq, reference.fromNextItemSeq);
    let top = reference.fromNextItemSeq - 1;
    for (const link of reference.via) {
      lower = viaStage(context, link, top, lower);
      top = link.nextItemSeq;
    }
    yield* mergeDescending(reference.synthesised, top, omitting(lower, reference.omitSeqs));
  }

  const compactionPointOf = (pointer: { runId: string; eventSeq: number }): CompactionPoint => {
    const row = eventAt.get({ runId: pointer.runId, seq: pointer.eventSeq });
    if (row === undefined) throw inconsistent(`run ${pointer.runId}: the compaction record at event seq ${pointer.eventSeq} is missing`);
    const event = decode(row);
    if (event.type === 'context.compacted') return { item: event.item, summary: event.summary, replacedThroughSeq: event.replacedThroughSeq };
    if (event.type === 'context.inherited' && !isReferenceInherited(event) && event.summary !== undefined) return event.summary;
    throw inconsistent(`run ${pointer.runId}: the record at event seq ${pointer.eventSeq} is not a compaction`);
  };

  const walkContextOf = (reference: InheritedReferencePayload, floor: number): WalkContext => ({
    floor,
    pointer: reference.compaction,
    visitedPointerRun: false,
    truncations: [],
    rejections: [],
    oldEvicted: new Set<string>(),
  });

  const tokensBeforeTheCopy = (sessionId: string, callId: string): number | undefined => {
    for (const owner of derived.read((view) => view.callOwnersOf(sessionId, callId))) {
      const row = recordedTokens.get({ runId: owner, callId });
      unit();
      if (row !== undefined && typeof row['tokens'] === 'number') return row['tokens'];
    }
    return undefined;
  };

  const settle = (context: WalkContext, collected: readonly HistoryEntry[], stubs: boolean, sessionId: string): { entries: WindowEntry[]; evicted: string[] } => {
    const entries: HistoryEntry[] = collected.map((entry) => ({ ...entry }));
    const tokens = new Map<string, number>();
    const evicted = new Set<string>();
    const present = new Map<string, number>();
    entries.forEach((entry, index) => {
      if (entry.item.type === 'function_call_output' && entry.callId !== undefined) present.set(entry.callId, index);
    });
    for (const truncation of [...context.truncations].reverse()) {
      const index = present.get(truncation.callId);
      if (index === undefined) continue;
      const entry = entries[index] as HistoryEntry;
      entries[index] = { ...entry, handle: truncation.kind === 'reference' ? (entry.handle ?? truncation.handle) : truncation.handle };
      if (truncation.kind === 'omitted') {
        evicted.add(truncation.callId);
        if (truncation.tokens !== undefined) tokens.set(truncation.callId, truncation.tokens);
      }
    }
    for (const callId of context.oldEvicted) {
      if (!present.has(callId)) continue;
      evicted.add(callId);
      if (stubs && !tokens.has(callId)) {
        const found = tokensBeforeTheCopy(sessionId, callId);
        if (found !== undefined) tokens.set(callId, found);
      }
    }
    const windowed = entries.map((entry): WindowEntry => {
      const recorded = entry.callId === undefined ? undefined : tokens.get(entry.callId);
      if (stubs && entry.item.type === 'function_call_output' && entry.callId !== undefined && entry.handle !== undefined && evicted.has(entry.callId) && recorded !== undefined) {
        return { seq: entry.seq, callId: entry.callId, handle: entry.handle, tokens: recorded };
      }
      return entry;
    });
    return { entries: windowed, evicted: [...evicted].sort() };
  };

  const summaryOf = (point: CompactionPoint, context: WalkContext): CompactionPoint => {
    const rejected = context.rejections.reduce<Rejection | undefined>((latest, candidate) => (latest === undefined || candidate.seq > latest.seq ? candidate : latest), undefined);
    return rejected === undefined ? point : { ...point, item: rejected.item };
  };

  type RecordHop = { runId: string; bound: number; skipSeq: number | undefined; from?: number };

  const recordHopsOf = (event: InheritedReferencePayload & RunEvent, subject: { runId: string }): RecordHop[] => {
    subject.runId = event.runId;
    if (referenceDigest(event) !== event.digest) throw inconsistent(`run ${event.runId}: context.inherited digest does not match its content`);
    const stack = [
      { runId: event.fromRunId, bound: event.fromLastSeq, taskSeq: undefined as number | undefined },
      ...event.via.map((link) => ({ runId: link.runId, bound: link.lastSeq, taskSeq: link.nextItemSeq as number | undefined })),
    ];
    const omits = [...event.via.map((link) => link.omitSeqs), event.omitSeqs];
    const hops: RecordHop[] = stack.map((entry) => ({ runId: entry.runId, bound: entry.bound, skipSeq: undefined }));
    stack.forEach((entry, index) => {
      subject.runId = entry.runId;
      if (selectRun.get({ id: entry.runId }) === undefined) throw inconsistent(`run ${entry.runId} does not exist`);
      const task = firstTask.get({ runId: entry.runId, bound: entry.bound });
      if (task === undefined) throw inconsistent(`run ${entry.runId}: its task record is missing`);
      const omitted = omits[index] ?? [];
      if (omitted.length === 0) return;
      const taskSeq = entry.taskSeq ?? inheritedEventOf(entry.runId)?.nextItemSeq ?? 1;
      if (omitted.length !== 1 || omitted[0] !== taskSeq) throw inconsistent(`run ${entry.runId}: the items omitted above it are ${JSON.stringify(omitted)}, not its task at item ${taskSeq}`);
      (hops[index] as RecordHop).skipSeq = Number(task['seq']);
    });
    return hops;
  };

  const recordChainOf = (request: RecordWalkRequest): RecordHop[] => {
    const planned: RecordHop[] = [];
    const subject = { runId: request.reference.runId };
    try {
      for (let level: (InheritedReferencePayload & RunEvent) | undefined = request.reference; level !== undefined; ) {
        const hops = recordHopsOf(level, subject);
        for (const hop of [...hops].reverse()) {
          const from = request.cover({ runId: hop.runId, bound: hop.bound, omitsTask: hop.skipSeq !== undefined });
          planned.push(from === undefined ? hop : { ...hop, from });
          if (from !== undefined) return planned.reverse();
        }
        subject.runId = level.fromRunId;
        const below = inheritedEventOf(level.fromRunId);
        level = below !== undefined && isReferenceInherited(below) ? below : undefined;
      }
    } catch (error) {
      if (!(error instanceof InheritanceError)) throw error;
      request.onFault({ runId: subject.runId, reason: error.message });
    }
    return planned.reverse();
  };

  const visitRecord = async (request: RecordWalkRequest): Promise<void> => {
    const visit: RecordVisit = (event) => (event.type === 'context.inherited' && isReferenceInherited(event) ? undefined : request.visit(event));
    for (const hop of recordChainOf(request)) {
      if (request.units.stop()) return;
      await walker.walk(hop.runId, hop.bound, request.types, visit, request.units, { ...(hop.skipSeq === undefined ? {} : { skipSeq: hop.skipSeq }), ...(hop.from === undefined ? {} : { from: hop.from }) });
    }
  };

  const referenceOfRun = (runId: string): InheritedReferencePayload & RunEvent => {
    const event = inheritedEventOf(runId);
    const reference = event === undefined ? undefined : referenceOf(event);
    if (reference === undefined) throw inconsistent(`run ${runId} holds no reference to read a window for`);
    return reference;
  };

  const windowOf = (request: InheritedWindowRequest): InheritedWindowReply => {
    const run = loadRun(request.runId);
    const reference = referenceOfRun(request.runId);
    const ownRow = latestCompacted.get({ runId: run.id, bound: run.lastSeq });
    const ownCompaction = ownRow === undefined ? undefined : decode(ownRow);
    const ownCut = ownCompaction?.type === 'context.compacted' ? ownCompaction.replacedThroughSeq : 0;
    const point = reference.compaction === undefined ? undefined : compactionPointOf(reference.compaction);
    const floor = Math.max(ownCut, point?.replacedThroughSeq ?? 0);
    const context = walkContextOf(reference, floor);
    const stream = streamOfReference(context, reference);
    const collected: HistoryEntry[] = [];
    const unmatched = new Set<string>();
    let sum = 0;
    let crossed = false;
    let omittedOlder = false;
    for (let next = stream.next(); !next.done; next = stream.next()) {
      const entry = next.value;
      if (entry.seq <= floor) break;
      if (crossed && unmatched.size === 0) {
        omittedOlder = true;
        break;
      }
      collected.push(entry);
      sum += lowerBoundTokens(entry.item, request.floorTokens);
      if (entry.item.type === 'function_call_output') unmatched.add(entry.item.call_id);
      else if (entry.item.type === 'function_call') unmatched.delete(entry.item.call_id);
      if (sum > request.windowTokens) crossed = true;
    }
    const [dangling] = unmatched;
    if (dangling !== undefined) throw inconsistent(`run ${run.id}: the output of call ${dangling} in its inherited history has no call`);
    const { entries, evicted } = settle(context, collected.reverse(), true, run.sessionId);
    const summary = point === undefined || ownCut > 0 ? undefined : summaryOf(point, context);
    return { lastSeq: run.lastSeq, ...(summary === undefined ? {} : { summary }), entries, evicted, omittedOlder };
  };

  const countAbove = (floor: number, seqs: readonly number[]): number => seqs.filter((seq) => seq > floor).length;

  const retainedCount = (reference: InheritedReferencePayload, floor: number): number => {
    let total = 0;
    let cursor: InheritedReferencePayload | undefined = reference;
    while (cursor !== undefined) {
      total += countAbove(floor, cursor.synthesised.map((entry) => entry.seq)) - countAbove(floor, cursor.omitSeqs);
      for (const link of cursor.via) {
        total += (link.nextItemSeq > floor ? 1 : 0) + countAbove(floor, link.synthesised.map((entry) => entry.seq)) - countAbove(floor, link.omitSeqs);
      }
      const event = inheritedEventOf(cursor.fromRunId);
      const taskSeq = event?.nextItemSeq ?? 1;
      total += Math.max(0, cursor.fromNextItemSeq - 1 - Math.max(taskSeq - 1, floor));
      if (event === undefined || floor >= taskSeq - 1) return total;
      if (!isReferenceInherited(event)) return total + countAbove(floor, event.history.map((entry) => entry.seq));
      cursor = event;
    }
    return total;
  };

  const retainedOf = (reference: InheritedReferencePayload & { type: 'context.inherited' }): RetainedHistory => {
    const point = reference.compaction === undefined ? undefined : compactionPointOf(reference.compaction);
    const context = walkContextOf(reference, point?.replacedThroughSeq ?? 0);
    const collected: HistoryEntry[] = [];
    for (const entry of streamOfReference(context, reference)) {
      if (entry.seq <= context.floor) break;
      collected.push(entry);
    }
    collected.reverse();
    const settled = settle(context, collected, false, '');
    return { entries: settled.entries as HistoryEntry[], ...(point === undefined ? {} : { summary: summaryOf(point, context) }), evicted: settled.evicted };
  };

  type Folded = { state: RunState; carriedSkills: string[]; pointer: { runId: string; eventSeq: number } | undefined };

  const foldOwn = (run: Run): Folded => {
    let state = initialRunState({ runId: run.id, sessionId: run.sessionId });
    let carriedSkills: string[] = [];
    let oldSummaryEventSeq: number | undefined;
    for (let from = 1; from <= run.lastSeq; from += INHERIT_RANGE_ROWS) {
      const until = Math.min(from + INHERIT_RANGE_ROWS, run.lastSeq + 1);
      const rows = foldRows.all({ runId: run.id, from, until });
      stepped(until - from);
      unit();
      for (const event of rows.flatMap(decodeKnown)) {
        if (event.type === 'context.inherited') {
          carriedSkills = (event.activatedSkills ?? []).map((skill) => skill.name);
          if (!isReferenceInherited(event)) oldSummaryEventSeq = event.summary === undefined ? undefined : event.seq;
        }
        state = foldRunState(state, event);
      }
    }
    const pointer =
      state.ownCompactionEventSeq !== undefined
        ? { runId: run.id, eventSeq: state.ownCompactionEventSeq }
        : state.inherited?.form === 'reference'
          ? state.inherited.compaction
          : oldSummaryEventSeq === undefined
            ? undefined
            : { runId: run.id, eventSeq: oldSummaryEventSeq };
    return { state, carriedSkills, pointer };
  };

  const outcomeOf = (run: Run & { status: TerminalStatus }): InheritanceOutcome => ({
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: knownValue(run.stopReason, `the stop reason of run ${run.id}`) }),
    ...(run.error === undefined ? {} : { errorCode: run.error.code }),
  });

  const predecessorOf = (child: Run): Run => {
    if (child.previousRunId === null) throw new InheritanceError('previous_run_inconsistent', `run ${child.id} has no previous run`);
    const row = selectRun.get({ id: child.previousRunId });
    if (row === undefined) throw new InheritanceError('previous_run_inconsistent', `previous run ${child.previousRunId} of run ${child.id} does not exist`);
    const previous = decodeRun(row, decodeContext);
    if (previous.sessionId !== child.sessionId || previous.ordinal !== child.ordinal - 1) {
      throw new InheritanceError('previous_run_inconsistent', `previous run ${previous.id} is not the run before ${child.id} in session ${child.sessionId}`);
    }
    return previous;
  };

  const hasInheritedEvent = (runId: string): boolean => firstInherited.get({ runId }) !== undefined;

  type TerminalRun = Run & { status: TerminalStatus };

  const resolveSource = (run: Run, { mode, unasked }: Pick<InheritPlanRequest, 'mode' | 'unasked'>): InheritPlanReply => {
    const walked: InheritWalked[] = [];
    const unmaterialised: TerminalRun[] = [];
    let base: TerminalRun;
    for (let cursor = run; ; ) {
      const previous = predecessorOf(cursor);
      if (previous.status === 'unknown' || !isTerminalStatus(previous.status)) return { kind: 'conflict', reason: `previous run ${previous.id} of run ${run.id} is ${previous.status}, not terminal` };
      const terminal = previous as TerminalRun;
      walked.push({ runId: previous.id, lastSeq: previous.lastSeq, status: previous.status });
      if (knownValue(previous.history, `the history mode of run ${previous.id}`) === 'fresh' || previous.previousRunId === null || hasInheritedEvent(previous.id)) {
        base = terminal;
        break;
      }
      unmaterialised.push(terminal);
      cursor = previous;
    }
    const folded = foldOwn(base);
    const baseState = folded.state;
    const pointerFloor = folded.pointer === undefined ? 0 : compactionPointOf(folded.pointer).replacedThroughSeq;
    let sourceRun: TerminalRun = base;
    let sourceState = baseState;
    let carriedSkills = folded.carriedSkills;
    const via: InheritedViaLink[] = [];
    for (const candidate of unmaterialised.reverse()) {
      const candidateState = foldOwn(candidate).state;
      if (retractsTask(candidateState, outcomeOf(candidate))) continue;
      const projection = projectReference(
        sourceState,
        { ...outcomeOf(sourceRun), carriedSkills },
        { kind: 'intermediate' },
        { fromRunId: base.id, fromLastSeq: base.lastSeq, fromNextItemSeq: baseState.nextItemSeq, via, itemCount: 0 },
      );
      via.push({ runId: candidate.id, lastSeq: candidate.lastSeq, ...projection.link });
      sourceState = rebaseOntoReference(candidateState, projection.unsigned, { fromRunId: base.id, fromLastSeq: base.lastSeq, digest: '', form: 'reference', fromNextItemSeq: baseState.nextItemSeq, itemCount: 0 });
      carriedSkills = (projection.unsigned.activatedSkills ?? []).map((skill) => skill.name);
      sourceRun = candidate;
    }
    const { unsigned } = projectReference(
      sourceState,
      { ...outcomeOf(sourceRun), carriedSkills },
      { kind: 'final', currentMode: mode, unasked },
      { fromRunId: base.id, fromLastSeq: base.lastSeq, fromNextItemSeq: baseState.nextItemSeq, ...(folded.pointer === undefined ? {} : { compaction: folded.pointer }), via, itemCount: 0 },
    );
    const itemCount = retainedCount({ ...unsigned, digest: '' }, pointerFloor);
    return { kind: 'ready', payload: signReference({ ...unsigned, itemCount }), walked };
  };

  const planOf = (request: InheritPlanRequest): InheritPlanReply => {
    const run = loadRun(request.runId);
    if (run.history !== 'inherit' || run.previousRunId === null) return { kind: 'none' };
    if (hasInheritedEvent(run.id)) return { kind: 'already' };
    try {
      return resolveSource(run, request);
    } catch (error) {
      if (error instanceof InheritanceError || isFatalStoreError(error)) throw error;
      throw new InheritanceError('previous_run_unreadable', `the previous run of ${run.id} could not be read`, { cause: error });
    }
  };

  return {
    visitRecord,
    planInheritance: (request) => readTx(db, () => planOf(request)),
    readInheritedWindow: (request) => readTx(db, () => windowOf(request)),
    retainedOf,
  };
};
