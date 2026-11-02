import { canonicalJson, isRecord } from '@momonga/foundation';
import type { PermissionOption, RunEvent } from '@momonga/protocol';

export const COMPACTION_LOSS_KINDS = ['history_read', 'rediscovery', 'repeated_failure', 'instruction_drift'] as const;

export type CompactionLossKind = (typeof COMPACTION_LOSS_KINDS)[number];

export type CompactionLossSignal = { kind: CompactionLossKind; compactionSeq: number; seq: number };

type CallRecord = { seq: number; name: string; input: unknown };

type LineRange = { from: number; to: number };

type ReadRecord = { sha256: string; ranges: LineRange[] };

type Outcomes = {
  reads: Map<string, ReadRecord>;
  commandFailed: Map<string, boolean>;
  refused: Map<string, boolean>;
};

type Snapshot = { compactionSeq: number } & Outcomes;

const HISTORY_READ_TOOL = 'HistoryRead';

const callKey = (call: CallRecord): string => `${call.name}\n${canonicalJson(call.input)}`;

const commandOf = (call: CallRecord): string | undefined => {
  if (call.name !== 'Bash' || !isRecord(call.input)) return undefined;
  const command = call.input['command'];
  return typeof command === 'string' ? command : undefined;
};

const WHOLE_RUN_FROM = 1;

const lineRangeOf = (call: CallRecord): LineRange => {
  const input = isRecord(call.input) ? call.input : {};
  const offset = typeof input['offset'] === 'number' ? input['offset'] : 1;
  const limit = typeof input['limit'] === 'number' ? input['limit'] : undefined;
  return { from: offset, to: limit === undefined ? Number.POSITIVE_INFINITY : offset + limit - 1 };
};

const overlaps = (ranges: readonly LineRange[], range: LineRange): boolean => ranges.some((seen) => seen.from <= range.to && range.from <= seen.to);

const copyOf = (outcomes: Outcomes): Outcomes => ({
  reads: new Map([...outcomes.reads].map(([path, record]) => [path, { sha256: record.sha256, ranges: [...record.ranges] }])),
  commandFailed: new Map(outcomes.commandFailed),
  refused: new Map(outcomes.refused),
});

const readsHistoryAtOrBelow = (call: CallRecord, runId: string, compactionSeq: number): boolean => {
  if (call.name !== HISTORY_READ_TOOL || !isRecord(call.input)) return false;
  const { runId: requestedRun, seqFrom } = call.input;
  const from = seqFrom === undefined ? WHOLE_RUN_FROM : seqFrom;
  return (requestedRun === undefined || requestedRun === runId) && typeof from === 'number' && from <= compactionSeq;
};

export const compactionLossSignals = (events: readonly RunEvent[]): CompactionLossSignal[] => {
  const signals: CompactionLossSignal[] = [];
  const calls = new Map<string, CallRecord>();
  const approvalOptions = new Map<string, { callId: string; options: readonly PermissionOption[] }>();
  const rejectedCalls = new Set<string>();
  const live: Outcomes = { reads: new Map(), commandFailed: new Map(), refused: new Map() };
  let snapshot: Snapshot | undefined;

  const signal = (kind: CompactionLossKind, call: CallRecord): void => {
    if (snapshot !== undefined) signals.push({ kind, compactionSeq: snapshot.compactionSeq, seq: call.seq });
  };

  for (const event of events) {
    switch (event.type) {
      case 'context.compacted':
        snapshot = { compactionSeq: event.seq, ...copyOf(live) };
        break;
      case 'tool.call': {
        const call: CallRecord = { seq: event.seq, name: event.name, input: event.rawInput };
        calls.set(event.callId, call);
        if (readsHistoryAtOrBelow(call, event.runId, snapshot?.compactionSeq ?? 0)) signal('history_read', call);
        if (snapshot?.refused.get(callKey(call)) === true) signal('instruction_drift', call);
        break;
      }
      case 'tool.permission.requested':
        approvalOptions.set(event.approvalId, { callId: event.callId, options: event.options });
        break;
      case 'tool.permission.resolved': {
        const approval = approvalOptions.get(event.approvalId);
        const kind = approval?.options.find((option) => option.optionId === event.optionId)?.kind;
        if (approval !== undefined && (kind === 'reject_once' || kind === 'reject_always')) rejectedCalls.add(approval.callId);
        break;
      }
      case 'tool.completed': {
        const call = calls.get(event.callId);
        if (call === undefined) break;
        const refused = event.denial !== undefined || rejectedCalls.has(event.callId);
        live.refused.set(callKey(call), refused);
        const readFile = event.files?.find((file) => file.access === 'read');
        if (readFile !== undefined) {
          const range = lineRangeOf(call);
          const before = snapshot?.reads.get(readFile.path);
          if (before?.sha256 === readFile.sha256 && overlaps(before.ranges, range)) signal('rediscovery', call);
          const known = live.reads.get(readFile.path);
          live.reads.set(readFile.path, {
            sha256: readFile.sha256,
            ranges: known?.sha256 === readFile.sha256 ? [...known.ranges, range] : [range],
          });
        }
        const command = commandOf(call);
        if (command !== undefined && !refused) {
          const failed = event.status === 'failed';
          if (failed && snapshot?.commandFailed.get(command) === true) signal('repeated_failure', call);
          live.commandFailed.set(command, failed);
        }
        break;
      }
      default:
        break;
    }
  }
  return signals;
};
