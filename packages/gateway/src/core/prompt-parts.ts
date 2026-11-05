const PROMPT_PART_KEYS: ReadonlySet<string> = new Set(['messages', 'system', 'instructions', 'input', 'tools']);

export const promptPartsOf = (wire: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(wire).filter(([key]) => PROMPT_PART_KEYS.has(key)));
