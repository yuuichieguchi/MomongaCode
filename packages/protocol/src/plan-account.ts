export const PLAN_LABEL_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';

export const PLAN_LABEL_REFUSAL = `the account label must match ${PLAN_LABEL_PATTERN}`;

const LABEL_SHAPE = new RegExp(PLAN_LABEL_PATTERN);

export const isPlanLabel = (value: unknown): value is string => typeof value === 'string' && LABEL_SHAPE.test(value);

export type PlanAccountRef = { profile: string; account?: string };

export type NamedPlanAccountRef = PlanAccountRef & { account: string };

const ownMember = (holder: object, name: string): unknown => (Object.hasOwn(holder, name) ? Reflect.get(holder, name) : undefined);

export const planAccountRefOf = (value: unknown): PlanAccountRef | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const profile = ownMember(value, 'profile');
  const account = ownMember(value, 'account');
  if (!isPlanLabel(profile)) return undefined;
  if (account === undefined) return { profile };
  return isPlanLabel(account) ? { profile, account } : undefined;
};
