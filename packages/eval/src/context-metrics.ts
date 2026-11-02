import { isRecord } from '@momonga/foundation';
import { compactionLossSignals } from '@momonga/memory';
import type { CompactionLossKind } from '@momonga/memory';
import type { PublicRunEvent } from '@momonga/protocol';
import { bindingRuleIds } from './context-dataset.ts';
import type { ContextRule, GoldRange } from './context-dataset.ts';
import { eventsOfType } from './observe.ts';
import { EvalError } from './runner.ts';

export type GovernanceCounts = { binding: number; bindingLoaded: number; loaded: number; consistent: boolean };

export type GovernanceScore = { fidelity: number; consistency: number; minimality: number | undefined };

export const governanceCountsOf = (rules: readonly ContextRule[], events: readonly PublicRunEvent[]): GovernanceCounts | undefined => {
  const binding = new Set(bindingRuleIds(rules));
  if (binding.size === 0) return undefined;
  const defined = new Set(rules.map((rule) => rule.id));
  const last = eventsOfType(events, 'context.governing_loaded').at(-1);
  const loaded = new Set((last?.active ?? []).map((fact) => fact.id).filter((id) => defined.has(id)));
  const bindingLoaded = [...binding].filter((id) => loaded.has(id)).length;
  return { binding: binding.size, bindingLoaded, loaded: loaded.size, consistent: loaded.size === binding.size && bindingLoaded === binding.size };
};

export const governanceOf = (rules: readonly ContextRule[], events: readonly PublicRunEvent[]): GovernanceScore | undefined => {
  const counts = governanceCountsOf(rules, events);
  if (counts === undefined) return undefined;
  return {
    fidelity: counts.bindingLoaded / counts.binding,
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

const HISTORY_READ_TOOL = 'HistoryRead';

const WHOLE_RUN_FROM = 1;

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
  const lastSeq = sequenced.reduce((last, event) => Math.max(last, event.seq), 0);
  return eventsOfType(events, 'tool.call').flatMap((call) => {
    if (call.name !== HISTORY_READ_TOOL || !isRecord(call.rawInput)) return [];
    const { runId, step, seqFrom, seqTo } = call.rawInput;
    if (runId !== undefined && runId !== call.runId) return [];
    let from = typeof seqFrom === 'number' ? seqFrom : WHOLE_RUN_FROM;
    let to = typeof seqTo === 'number' ? seqTo : lastSeq;
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
  const measured = compactions.flatMap((event) => (event.source === 'model' && event.fidelity !== undefined ? [event.fidelity] : []));
  return {
    compactions: compactions.length,
    modelSummaries: measured.length,
    fabricatedSummaries: measured.filter((fidelity) => fidelity.fabricated.length > 0).length,
    identifiers: measured.reduce((sum, fidelity) => sum + fidelity.identifiers, 0),
    retained: measured.reduce((sum, fidelity) => sum + fidelity.retained, 0),
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
