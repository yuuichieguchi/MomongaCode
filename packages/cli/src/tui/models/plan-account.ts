import type { PlanAccountRef, PlanAccountView } from '@momonga/protocol';

export const planServesAccount = (plan: PlanAccountRef, account: Pick<PlanAccountView, 'profile' | 'label' | 'active'>): boolean =>
  plan.profile === account.profile && (plan.account === undefined ? account.active : plan.account === account.label);
