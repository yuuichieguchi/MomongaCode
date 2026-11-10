export type PlanAccountRef = { profile: string; account: string };

export const planAccountRefOf = (value: unknown): PlanAccountRef | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { profile, account } = value as Record<string, unknown>;
  return typeof profile === 'string' && typeof account === 'string' ? { profile, account } : undefined;
};
