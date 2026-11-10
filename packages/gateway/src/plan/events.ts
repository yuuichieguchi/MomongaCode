import type { EventPayload } from '@momonga/foundation';

export type PlanEventName = 'plan.sign_in' | 'plan.refresh' | 'plan.rejected' | 'plan.sign_out' | 'plan.pause' | 'plan.catalog';

export type PlanEvents = (name: PlanEventName, data: EventPayload) => void;

export const noPlanEvents: PlanEvents = () => undefined;
