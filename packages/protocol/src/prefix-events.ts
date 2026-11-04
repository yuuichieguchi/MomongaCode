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
