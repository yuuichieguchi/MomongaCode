export const CORE_SETTING_KEYS = [
  'context.adaptiveBudget',
  'context.autoCompact',
  'context.cachePrefix',
  'context.outputFormatters',
  'context.loopGuidance',
  'context.observedCapacity',
  'context.unboundedOutputReserve',
  'tools.deferral',
  'tools.conciseDescriptions',
  'memory.repositoryFacts',
  'memory.reflection.enabled',
] as const;

export type CoreSettingKey = (typeof CORE_SETTING_KEYS)[number];
