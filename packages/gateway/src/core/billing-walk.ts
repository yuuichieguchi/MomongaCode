import type { TargetBilling } from '@momonga/protocol';

export type BillingWalk = { initial: TargetBilling; allows(from: TargetBilling, to: TargetBilling): boolean };
