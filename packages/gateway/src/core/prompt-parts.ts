export const PROMPT_PART_KEYS = ['messages', 'system', 'instructions', 'input', 'tools'] as const;

export type PromptPartKey = (typeof PROMPT_PART_KEYS)[number];

const isPromptPartKey = (key: string): key is PromptPartKey => (PROMPT_PART_KEYS as readonly string[]).includes(key);

export const promptPartsOf = <Wire extends Readonly<Record<string, unknown>>>(wire: Wire): Pick<Wire, Extract<keyof Wire, PromptPartKey>> =>
  Object.fromEntries(Object.entries(wire).filter(([key]) => isPromptPartKey(key))) as Pick<Wire, Extract<keyof Wire, PromptPartKey>>;
