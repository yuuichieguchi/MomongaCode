export const BILLING_CHANGE_ALLOWED = 'billing_change_allowed';
export const BILLING_CHANGE_REFUSED = 'billing_change_refused';

export type BillingChangeRecord = { fromBilling: string; toBilling: string; reason: typeof BILLING_CHANGE_ALLOWED | typeof BILLING_CHANGE_REFUSED };

export type FallbackCause = { target: string; code: string | null; message: string } & (BillingChangeRecord | { fromBilling?: never; toBilling?: never; reason?: never });

const failureOf = (cause: FallbackCause): string => `${cause.target} failed (${cause.code === null ? cause.message : `${cause.code}: ${cause.message}`})`;

export const describeFallbackCause = (cause: FallbackCause): string => {
  if (cause.reason === BILLING_CHANGE_REFUSED) return `changing from ${cause.fromBilling} to ${cause.toBilling} billing is not allowed, so ${cause.target} was not tried`;
  if (cause.reason === BILLING_CHANGE_ALLOWED) return `${failureOf(cause)}, so the request changed from ${cause.fromBilling} to ${cause.toBilling} billing as models.billingChanges allows`;
  return failureOf(cause);
};
