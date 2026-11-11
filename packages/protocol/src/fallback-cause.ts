import { TARGET_BILLINGS } from './capabilities.ts';
import type { TargetBilling } from './capabilities.ts';
import { messageOf } from './vocabulary.ts';
import type { Surface } from './vocabulary.ts';

export const BILLING_CHANGE_ALLOWED = 'billing_change_allowed' as const;
export const BILLING_CHANGE_REFUSED = 'billing_change_refused' as const;
export const BILLING_CHANGE_REASONS = [BILLING_CHANGE_ALLOWED, BILLING_CHANGE_REFUSED] as const;
export type BillingChangeReason = (typeof BILLING_CHANGE_REASONS)[number];

export type BillingChangeRecord = { fromBilling: TargetBilling; toBilling: TargetBilling; reason: BillingChangeReason };

export type FallbackCause = { target: string; name?: string; code: string | null; message: string } & (BillingChangeRecord | { fromBilling?: never; toBilling?: never; reason?: never });

type WithoutMessage<Cause> = Cause extends unknown ? Omit<Cause, 'message'> & { message?: string } : never;

export type SpanFallbackCause = WithoutMessage<FallbackCause>;

export const spanFallbackCauseOf = (cause: FallbackCause, captureMessageContent: boolean): SpanFallbackCause => {
  if (captureMessageContent) return cause;
  const { message: _message, ...projected } = cause;
  return projected;
};

const BASE_KEYS: readonly string[] = ['target', 'name', 'code', 'message'];
const BILLING_KEYS: readonly string[] = ['fromBilling', 'toBilling', 'reason'];

const isTargetBilling = (value: unknown): value is TargetBilling => TARGET_BILLINGS.some((billing) => billing === value);

const isBillingChangeReason = (value: unknown): value is BillingChangeReason => BILLING_CHANGE_REASONS.some((reason) => reason === value);

const isCauseShape = (value: unknown, messageRequired: boolean): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) => BASE_KEYS.includes(key) || BILLING_KEYS.includes(key))) return false;
  if (typeof record['target'] !== 'string') return false;
  if (typeof record['message'] !== 'string' && (messageRequired || record['message'] !== undefined)) return false;
  if (record['name'] !== undefined && typeof record['name'] !== 'string') return false;
  if (typeof record['code'] !== 'string' && record['code'] !== null) return false;
  if (!keys.some((key) => BILLING_KEYS.includes(key))) return true;
  return isTargetBilling(record['fromBilling']) && isTargetBilling(record['toBilling']) && isBillingChangeReason(record['reason']);
};

export const isFallbackCause = (value: unknown): value is FallbackCause => isCauseShape(value, true);

export const isSpanFallbackCause = (value: unknown): value is SpanFallbackCause => isCauseShape(value, false);

export const isFallbackCauseList = (value: unknown): value is FallbackCause[] => Array.isArray(value) && value.every(isFallbackCause);

export const isSpanFallbackCauseList = (value: unknown): value is SpanFallbackCause[] => Array.isArray(value) && value.every(isSpanFallbackCause);

export const fallbackCauseName = (cause: SpanFallbackCause): string => cause.name ?? cause.target;

const failureDetailOf = (cause: SpanFallbackCause): string => [cause.code, cause.message].filter((part): part is string => part !== null && part !== undefined).join(': ');

const failureOf = (cause: SpanFallbackCause): string => `${fallbackCauseName(cause)} failed (${failureDetailOf(cause)})`;

export const describeFallbackCause = (cause: SpanFallbackCause, surface: Surface): string => {
  if (cause.reason === BILLING_CHANGE_REFUSED) return messageOf('billingChangeRefused', surface, { model: fallbackCauseName(cause), from: cause.fromBilling, to: cause.toBilling });
  if (cause.reason === BILLING_CHANGE_ALLOWED) return `${failureOf(cause)}, so the request changed from ${cause.fromBilling} to ${cause.toBilling} billing as models.billingChanges allows`;
  return failureOf(cause);
};
