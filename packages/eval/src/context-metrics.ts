import { isRecord } from '@momonga/foundation';
import { HISTORY_READ_TOOL, WHOLE_RUN_FROM, compactionLossSignals } from '@momonga/memory';
import type { CompactionLossKind } from '@momonga/memory';
import type { PublicRunEvent } from '@momonga/protocol';
import { bindingRuleIds } from './context-dataset.ts';
import type { ContextRule, GoldRange } from './context-dataset.ts';
import { eventsOfType } from './observe.ts';
import { EvalError } from './runner.ts';

export type GovernanceCounts = { binding: number; bindingLoaded: number; loaded: number; consistent: boolean; loads: number };

export type GovernanceScore = { fidelity: number | undefined; consistency: number; minimality: number | undefined };

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => left.size === right.size && [...left].every((id) => right.has(id));

export const governanceCountsOf = (rules: readonly ContextRule[], events: readonly PublicRunEvent[]): GovernanceCounts | undefined => {
  if (rules.length === 0) return undefined;
  const binding = new Set(bindingRuleIds(rules));
  const defined = new Set(rules.map((rule) => rule.id));
  const loads = eventsOfType(events, 'context.governing_loaded').map((event) => new Set(event.active.map((fact) => fact.id).filter((id) => defined.has(id))));
  const last = loads.at(-1) ?? new Set<string>();
  return {
    binding: binding.size,
    bindingLoaded: [...binding].filter((id) => last.has(id)).length,
    loaded: last.size,
    consistent: (loads.length === 0 ? [last] : loads).every((load) => sameSet(load, binding)),
    loads: loads.length,
  };
};

export const governanceOf = (rules: readonly ContextRule[], events: readonly PublicRunEvent[]): GovernanceScore | undefined => {
  const counts = governanceCountsOf(rules, events);
  if (counts === undefined) return undefined;
  return {
    fidelity: counts.binding === 0 ? undefined : counts.bindingLoaded / counts.binding,
    consistency: counts.consistent ? 1 : 0,
    minimality: counts.loaded === 0 ? undefined : counts.bindingLoaded / counts.loaded,
  };
};

export type Recalled = { stale: number; recalled: number };

export const recalledOf = (events: readonly PublicRunEvent[]): Recalled => {
  const loads = eventsOfType(events, 'context.memories_loaded').flatMap((event) => event.memories);
  return { stale: loads.filter((memory) => memory.status === 'stale').length, recalled: loads.length };
};

export type Retrieval = { relevant: number; retrieved: number; gold: number };

type SequencedEvent = Extract<PublicRunEvent, { seq: number }>;

const isSequenced = (event: PublicRunEvent): event is SequencedEvent => 'seq' in event;

const mergeRanges = (ranges: readonly GoldRange[]): GoldRange[] => {
  const merged: GoldRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.seqFrom - b.seqFrom)) {
    const last = merged.at(-1);
    if (last !== undefined && range.seqFrom <= last.seqTo + 1) last.seqTo = Math.max(last.seqTo, range.seqTo);
    else merged.push({ ...range });
  }
  return merged;
};

const lengthOf = (ranges: readonly GoldRange[]): number => ranges.reduce((sum, range) => sum + range.seqTo - range.seqFrom + 1, 0);

const overlapOf = (left: readonly GoldRange[], right: readonly GoldRange[]): number =>
  left.reduce((sum, a) => sum + right.reduce((inner, b) => inner + Math.max(0, Math.min(a.seqTo, b.seqTo) - Math.max(a.seqFrom, b.seqFrom) + 1), 0), 0);

const historyRangesOf = (events: readonly PublicRunEvent[]): GoldRange[] => {
  const sequenced = events.filter(isSequenced);
  const delivered = new Set(
    eventsOfType(events, 'tool.completed')
      .filter((done) => done.status === 'completed' && done.denial === undefined)
      .map((done) => done.callId),
  );
  return eventsOfType(events, 'tool.call').flatMap((call) => {
    if (call.name !== HISTORY_READ_TOOL || !delivered.has(call.callId) || !isRecord(call.rawInput)) return [];
    const { runId, step, seqFrom, seqTo } = call.rawInput;
    if (runId !== undefined && runId !== call.runId) return [];
    let from = typeof seqFrom === 'number' ? seqFrom : WHOLE_RUN_FROM;
    let to = Math.min(typeof seqTo === 'number' ? seqTo : call.seq, call.seq);
    if (typeof step === 'number') {
      const stepSeqs = sequenced.filter((event) => event.step === step).map((event) => event.seq);
      if (stepSeqs.length === 0) return [];
      from = Math.max(from, stepSeqs.reduce((low, seq) => Math.min(low, seq)));
      to = Math.min(to, stepSeqs.reduce((high, seq) => Math.max(high, seq)));
    }
    return from <= to ? [{ seqFrom: from, seqTo: to }] : [];
  });
};

export const retrievalOf = (gold: readonly GoldRange[], events: readonly PublicRunEvent[]): Retrieval => {
  const wanted = mergeRanges(gold);
  const retrieved = mergeRanges(historyRangesOf(events));
  return { relevant: overlapOf(retrieved, wanted), retrieved: lengthOf(retrieved), gold: lengthOf(wanted) };
};

export type CompactionFacts = {
  compactions: number;
  modelSummaries: number;
  fabricatedSummaries: number;
  identifiers: number;
  retained: number;
  unclassified: number;
};

export const compactionFactsOf = (events: readonly PublicRunEvent[]): CompactionFacts => {
  const compactions = eventsOfType(events, 'context.compacted');
  const produced = compactions.flatMap((event) => (event.fidelity === undefined ? [] : [{ source: event.source, fidelity: event.fidelity }]));
  const accepted = produced.filter((summary) => summary.source === 'model');
  return {
    compactions: compactions.length,
    modelSummaries: produced.length,
    fabricatedSummaries: produced.filter((summary) => summary.fidelity.fabricated.length > 0).length,
    identifiers: accepted.reduce((sum, summary) => sum + summary.fidelity.identifiers, 0),
    retained: accepted.reduce((sum, summary) => sum + summary.fidelity.retained, 0),
    unclassified: compactions.filter((event) => event.source === undefined || (event.source === 'model' && event.fidelity === undefined)).length,
  };
};

export type LossSignal = { kind: CompactionLossKind; callId: string; compactionSeq: number; seq: number };

export const lossSignalsOf = (events: readonly PublicRunEvent[]): LossSignal[] => {
  const callIds = new Map(eventsOfType(events, 'tool.call').map((call) => [call.seq, call.callId]));
  return compactionLossSignals(events).map((signal) => {
    const callId = callIds.get(signal.seq);
    if (callId === undefined) throw new EvalError(`the loss signal at seq ${signal.seq} does not belong to a tool call`);
    return { ...signal, callId };
  });
};
