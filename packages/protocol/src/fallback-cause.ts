import { TARGET_BILLINGS } from './capabilities.ts';
import type { TargetBilling } from './capabilities.ts';

export const BILLING_CHANGE_ALLOWED = 'billing_change_allowed' as const;
export const BILLING_CHANGE_REFUSED = 'billing_change_refused' as const;
export const BILLING_CHANGE_REASONS = [BILLING_CHANGE_ALLOWED, BILLING_CHANGE_REFUSED] as const;
export type BillingChangeReason = (typeof BILLING_CHANGE_REASONS)[number];

export type BillingChangeRecord = { fromBilling: TargetBilling; toBilling: TargetBilling; reason: BillingChangeReason };

export type FallbackCause = { target: string; name?: string; code: string | null; message: string } & (BillingChangeRecord | { fromBilling?: never; toBilling?: never; reason?: never });

const BASE_KEYS: readonly string[] = ['target', 'name', 'code', 'message'];
const BILLING_KEYS: readonly string[] = ['fromBilling', 'toBilling', 'reason'];

const isTargetBilling = (value: unknown): value is TargetBilling => TARGET_BILLINGS.some((billing) => billing === value);

const isBillingChangeReason = (value: unknown): value is BillingChangeReason => BILLING_CHANGE_REASONS.some((reason) => reason === value);

export const isFallbackCause = (value: unknown): value is FallbackCause => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) => BASE_KEYS.includes(key) || BILLING_KEYS.includes(key))) return false;
  if (typeof record['target'] !== 'string' || typeof record['message'] !== 'string') return false;
  if (record['name'] !== undefined && typeof record['name'] !== 'string') return false;
  if (typeof record['code'] !== 'string' && record['code'] !== null) return false;
  if (!keys.some((key) => BILLING_KEYS.includes(key))) return true;
  return isTargetBilling(record['fromBilling']) && isTargetBilling(record['toBilling']) && isBillingChangeReason(record['reason']);
};

export const isFallbackCauseList = (value: unknown): value is FallbackCause[] => Array.isArray(value) && value.every(isFallbackCause);

export const fallbackCauseName = (cause: FallbackCause): string => cause.name ?? cause.target;

const failureOf = (cause: FallbackCause): string => `${fallbackCauseName(cause)} failed (${cause.code === null ? cause.message : `${cause.code}: ${cause.message}`})`;

export const describeFallbackCause = (cause: FallbackCause): string => {
  if (cause.reason === BILLING_CHANGE_REFUSED) return `changing from ${cause.fromBilling} to ${cause.toBilling} billing is not allowed, so ${fallbackCauseName(cause)} was not tried`;
  if (cause.reason === BILLING_CHANGE_ALLOWED) return `${failureOf(cause)}, so the request changed from ${cause.fromBilling} to ${cause.toBilling} billing as models.billingChanges allows`;
  return failureOf(cause);
};
