import type { EventPayload } from '@momonga/foundation';
import { GatewayError } from '../core/errors.ts';
import { PlanCredentialError } from './auth-source.ts';

export type PlanEventName = 'plan.sign_in' | 'plan.refresh' | 'plan.rejected' | 'plan.sign_out' | 'plan.pause' | 'plan.catalog';

export type PlanEvents = (name: PlanEventName, data: EventPayload) => void;

export const noPlanEvents: PlanEvents = () => undefined;

export const PLAN_EVENT_INTERNAL = 'internal';

export const endCodeOf = (error: unknown): string => {
  if (error instanceof PlanCredentialError) return error.code;
  if (error instanceof GatewayError && typeof error.body.code === 'string') return error.body.code;
  return PLAN_EVENT_INTERNAL;
};
