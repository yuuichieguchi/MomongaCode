import { textOfItem } from '@momonga/context';
import { isRecord, jsonValueOrText } from '@momonga/foundation';
import { createCallRunTracker } from '@momonga/memory';
import { EXECUTED_TEXT_EVENT_TYPES, callInputTracker, readExecutedText, tokenMatcherOf } from '@momonga/protocol';
import type { ClaimedToken, ExecutedTextHandlers, FidelityClaim, RunEvent } from '@momonga/protocol';
import { VERDICT_RANKS } from '@momonga/store';
import type { FidelityVerdict, FidelityVerdictRow, VerdictRank } from '@momonga/store';

export const FIDELITY_EVENT_TYPES = [
  ...EXECUTED_TEXT_EVENT_TYPES,
  'model.responded',
  'user.message',
  'plan.updated',
  'instructions.loaded',
  'context.inherited',
] as const satisfies readonly RunEvent['type'][];

export type ReferenceEvent = Extract<RunEvent, { type: 'context.inherited'; form: 'reference' }>;

export type RecordPort = (event: ReferenceEvent, add: (event: RunEvent) => void | Promise<void>) => void | Promise<void>;

export type HandleOrigin = { inherited: boolean; ownSeq: number | undefined };

export type FidelityFold = {
  add(event: RunEvent): void | Promise<void>;
  finish(): void;
  readonly handles: ReadonlyMap<string, HandleOrigin>;
  readonly unresolved: number;
  readonly chainSkipped: boolean;
  readonly span: number;
  scan(text: string, complete: boolean, handle: string): void;
  attested(): string[];
  applyHop(token: string, row: FidelityVerdictRow, omitsTask: boolean): void;
  seedOwn(row: FidelityVerdictRow): void;
  resumeAfterTask(): void;
  pendingFloor(): number | undefined;
  verdicts(): FidelityVerdict[];
};

type Phase = 'inherited' | 'own';

type Source = 'executed' | 'stated';

const STATED = 1;
const EXECUTED = 2;

const rankOfSource = (source: Source): number => (source === 'executed' ? EXECUTED : STATED);

const rankOfName = (name: VerdictRank): number => VERDICT_RANKS.indexOf(name);

const stringLeavesOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeavesOf);
  if (isRecord(value)) return Object.values(value).flatMap(stringLeavesOf);
  return [];
};

const claimSatisfiedBy = (rank: number, claim: FidelityClaim): boolean => rank >= EXECUTED || (rank >= STATED && claim === 'any');

const earlier = (current: number | null, candidate: number): number => (current === null ? candidate : Math.min(current, candidate));

type Entry = ClaimedToken & {
  matcher: ReturnType<typeof tokenMatcherOf>;
  found: boolean;
  inh: number;
  inhDeps: string[];
  taskStated: boolean;
  statedAt: number | null;
  executedAt: number | null;
  ownDeps: string[];
};

type PendingCall = { leaves: string[]; seq: number; phase: Phase };

const ownRankOf = (entry: Entry): number => (entry.executedAt !== null ? EXECUTED : entry.statedAt !== null || entry.taskStated ? STATED : 0);

const rankOf = (entry: Entry): number => Math.max(entry.inh, ownRankOf(entry));

export const createFidelityFold = (tokens: readonly ClaimedToken[], cwd: string, record: RecordPort): FidelityFold => {
  const inputs = callInputTracker(jsonValueOrText);
  const entries: Entry[] = tokens.map((entry) => ({
    ...entry,
    matcher: tokenMatcherOf(entry.token, cwd),
    found: false,
    inh: 0,
    inhDeps: [],
    taskStated: false,
    statedAt: null,
    executedAt: null,
    ownDeps: [],
  }));
  const handles = new Map<string, HandleOrigin>();
  const calls = new Map<string, PendingCall>();
  const ran = createCallRunTracker();
  let unresolved = entries.length;
  let maxed = 0;
  let taskSeen = false;
  let chainSkipped = false;

  const refresh = (entry: Entry): void => {
    const rank = rankOf(entry);
    if (!entry.found && claimSatisfiedBy(rank, entry.claim)) {
      entry.found = true;
      unresolved -= 1;
    }
  };

  const countMaxed = (): void => {
    maxed = entries.filter((entry) => rankOf(entry) >= EXECUTED).length;
  };

  const offer = (text: string, source: Source, phase: Phase, seq: number, task = false): void => {
    if (maxed === entries.length) return;
    for (const entry of entries) {
      if (rankOf(entry) >= EXECUTED || !entry.matcher.matches(text, true)) continue;
      if (phase === 'inherited') entry.inh = Math.max(entry.inh, rankOfSource(source));
      else if (task) entry.taskStated = true;
      else if (source === 'executed') entry.executedAt = earlier(entry.executedAt, seq);
      else entry.statedAt = earlier(entry.statedAt, seq);
      refresh(entry);
    }
    countMaxed();
  };

  const executedText: ExecutedTextHandlers<Phase> = {
    'tool.call': (event, phase) => {
      calls.set(event.callId, { leaves: stringLeavesOf(inputs.inputOf(event)), seq: event.seq, phase });
    },
    'tool.started': () => undefined,
    'tool.completed': (event, phase) => {
      const pending = calls.get(event.callId);
      calls.delete(event.callId);
      if (event.denial !== undefined) return;
      if (ran.ran(event)) for (const leaf of pending?.leaves ?? []) offer(leaf, 'executed', phase, event.seq);
      offer(event.output, 'executed', phase, event.seq);
      for (const file of event.files ?? []) offer(file.path, 'executed', phase, event.seq);
      if (event.handle !== undefined) noteHandle(event.handle, phase, event.seq);
    },
    'tool.reconciled': (event, phase) => {
      const pending = calls.get(event.callId);
      calls.delete(event.callId);
      if (event.outcome === 'already_applied') for (const leaf of pending?.leaves ?? []) offer(leaf, 'executed', phase, event.seq);
      offer(event.output, 'executed', phase, event.seq);
    },
    'tool.held.resolved': (event, phase) => {
      offer(event.output, 'executed', phase, event.seq);
    },
    'verification.completed': (event, phase) => {
      offer(event.command, 'executed', phase, event.seq);
      offer(event.output, 'executed', phase, event.seq);
      if (event.handle !== undefined) noteHandle(event.handle, phase, event.seq);
    },
  };

  const process = (event: RunEvent, phase: Phase): void | Promise<void> => {
    ran.observe(event);
    inputs.observe(event);
    if (readExecutedText(event, executedText, phase)) return;
    const executed = (text: string): void => offer(text, 'executed', phase, event.seq);
    const stated = (text: string): void => offer(text, 'stated', phase, event.seq);
    switch (event.type) {
      case 'user.message': {
        const task = phase === 'own' && !taskSeen;
        if (task) taskSeen = true;
        offer(event.text, 'stated', phase, event.seq, task);
        for (const record of event.shell ?? []) if (record.include) executed(record.output);
        return;
      }
      case 'plan.updated':
        for (const entry of event.entries) stated(entry.content);
        return;
      case 'instructions.loaded':
        executed(event.content);
        return;
      case 'context.inherited':
        if (event.form === 'reference') {
          if (unresolved > 0) return record(event, addInherited);
          chainSkipped = true;
          return;
        }
        for (const entry of event.history) {
          if (entry.handle !== undefined) noteHandle(entry.handle, 'inherited', event.seq);
          if (entry.item.type === 'message') {
            if (entry.item.role === 'user') offer(textOfItem(entry.item), 'stated', 'inherited', event.seq);
          } else if (entry.item.type === 'function_call' || entry.item.type === 'function_call_output') {
            offer(textOfItem(entry.item), 'executed', 'inherited', event.seq);
          }
        }
        return;
      default:
        return;
    }
  };

  const noteHandle = (handle: string, phase: Phase, seq: number): void => {
    const known = handles.get(handle);
    if (phase === 'inherited') handles.set(handle, { inherited: true, ownSeq: known?.ownSeq });
    else handles.set(handle, { inherited: known?.inherited ?? false, ownSeq: known?.ownSeq === undefined ? seq : Math.min(known.ownSeq, seq) });
  };

  const addInherited = (event: RunEvent): void | Promise<void> => process(event, 'inherited');

  const finish = (): void => {
    calls.clear();
  };

  const scan = (text: string, complete: boolean, handle: string): void => {
    const origin = handles.get(handle);
    if (origin === undefined) throw new Error(`blob ${handle} was scanned though no event named it`);
    for (const entry of entries) {
      if (rankOf(entry) >= EXECUTED || !entry.matcher.matches(text, complete)) continue;
      if (origin.inherited) {
        entry.inh = EXECUTED;
        entry.inhDeps = [handle];
      }
      if (origin.ownSeq !== undefined && (entry.executedAt === null || origin.ownSeq < entry.executedAt)) {
        entry.executedAt = origin.ownSeq;
        entry.ownDeps = [handle];
      }
      refresh(entry);
    }
    countMaxed();
  };

  const entryOf = (token: string): Entry => {
    const entry = entries.find((candidate) => candidate.token === token);
    if (entry === undefined) throw new Error(`token ${token} is not one of the tokens of this check`);
    return entry;
  };

  const applyHop = (token: string, row: FidelityVerdictRow, omitsTask: boolean): void => {
    const entry = entryOf(token);
    const fromRow = Math.max(rankOfName(row.inh), row.executedAt !== null ? EXECUTED : 0, row.statedAt !== null || (row.taskStated && !omitsTask) ? STATED : 0);
    if (fromRow > entry.inh) {
      entry.inh = fromRow;
      entry.inhDeps = fromRow >= EXECUTED ? (rankOfName(row.inh) >= EXECUTED ? row.inhDeps : row.ownDeps) : [];
    }
    refresh(entry);
    countMaxed();
  };

  const seedOwn = (row: FidelityVerdictRow): void => {
    const entry = entryOf(row.token);
    entry.inh = Math.max(entry.inh, rankOfName(row.inh));
    entry.inhDeps = row.inhDeps;
    entry.taskStated = row.taskStated;
    entry.statedAt = row.statedAt;
    entry.executedAt = row.executedAt;
    entry.ownDeps = row.ownDeps;
    refresh(entry);
    countMaxed();
  };

  const pendingFloor = (): number | undefined => {
    const own = [...calls.values()].filter((call) => call.phase === 'own').map((call) => call.seq);
    return own.length === 0 ? undefined : Math.min(...own);
  };

  return {
    add: (event) => process(event, 'own'),
    finish,
    handles,
    get unresolved() {
      return unresolved;
    },
    get chainSkipped() {
      return chainSkipped;
    },
    get span() {
      return Math.max(0, ...entries.filter((entry) => rankOf(entry) < EXECUTED).map((entry) => entry.matcher.span));
    },
    scan,
    attested: () => entries.filter((entry) => entry.found).map((entry) => entry.token),
    applyHop,
    seedOwn,
    resumeAfterTask: () => {
      taskSeen = true;
    },
    pendingFloor,
    verdicts: () =>
      entries.map((entry) => ({
        token: entry.token,
        inh: VERDICT_RANKS[entry.inh] ?? 'none',
        inhDeps: entry.inhDeps,
        taskStated: entry.taskStated,
        statedAt: entry.statedAt,
        executedAt: entry.executedAt,
        ownDeps: entry.ownDeps,
      })),
  };
};
