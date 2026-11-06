export type SettingsUse = 'admit' | 'read';

export type Kept<T> = { value: T } | undefined;

export const keptOrThrow = <T>(use: SettingsUse, kept: Kept<T>, error: unknown): T => {
  if (use === 'read' && kept !== undefined) return kept.value;
  throw error;
};
