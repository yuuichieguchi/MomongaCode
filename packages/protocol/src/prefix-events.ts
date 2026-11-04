export const PREFIX_EVENTS = [
  'eviction',
  'compaction',
  'compaction_rejected',
  'governing_changed',
  'instructions_arrived',
  'instructions_replaced',
  'skill_activated',
  'tools_loaded',
  'claim',
  'wrap_up',
] as const;

export type PrefixEvent = (typeof PREFIX_EVENTS)[number];

export const CACHE_MISS_CAUSES = [...PREFIX_EVENTS, 'target_changed', 'side_call', 'unexplained'] as const;

export type CacheMissCause = (typeof CACHE_MISS_CAUSES)[number];
