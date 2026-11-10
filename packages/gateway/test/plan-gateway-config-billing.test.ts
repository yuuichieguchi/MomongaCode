import { describe, expect, it } from 'vitest';
import { gatewayConfigOf } from '@momonga/gateway';

describe('models.billingChanges of the user settings reaches the gateway config (P5a-w, M9)', () => {
  it('carries the resolved pairs into GatewayConfig.models.billingChanges', () => {
    const config = (gatewayConfigOf as unknown as (...args: unknown[]) => { models: Record<string, unknown> })(
      {},
      {},
      undefined,
      undefined,
      [{ from: 'plan', to: 'metered', alias: 'default' }],
    );
    expect(config.models['billingChanges']).toEqual([{ from: 'plan', to: 'metered', alias: 'default' }]);
  });
});
