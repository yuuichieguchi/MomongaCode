export { checkGoverningFact, normalizeTarget, overlappingEnforced, ruleSizeReport } from './governing-facts.ts';
export type { GoverningFactCheck, GoverningFactRefusalCode, RuleSizeEntry, RuleSizeTarget } from './governing-facts.ts';
export { EvidenceOutsideRootError, memoryStatus } from './memory-status.ts';
export type { EvidencePorts, MemoryStatusContext } from './memory-status.ts';
export { recallOrder } from './recall-order.ts';
export { resolveGoverning, scopeKeyOf } from './resolve-governing.ts';
export type { GoverningConflict, GoverningResolution, ResolveGoverningOptions } from './resolve-governing.ts';
export { COMPACTION_LOSS_KINDS, compactionLossSignals } from './compaction-loss.ts';
export type { CompactionLossKind, CompactionLossSignal } from './compaction-loss.ts';
