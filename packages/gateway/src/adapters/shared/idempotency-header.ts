import type { AdapterContext } from '@momonga/protocol';

export const idempotencyHeaderOf = (ctx: Pick<AdapterContext, 'capabilities' | 'idempotencyKey'>, part = 0): Record<string, string> => {
  const declared = ctx.capabilities.idempotencyKey;
  if (declared === undefined || ctx.idempotencyKey === undefined) return {};
  return { [declared.header]: part === 0 ? ctx.idempotencyKey : `${ctx.idempotencyKey}-${part}` };
};
