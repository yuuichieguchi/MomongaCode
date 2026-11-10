import { describe, expect, it } from 'vitest';
import { gatewayConfigOf } from '@momonga/gateway';

describe('models.billingChanges of the user settings reaches the gateway config (P5a-w, M9)', () => {
  it('carries the resolved pairs into GatewayConfig.models.billingChanges', () => {
    const billingChanges = [{ from: 'plan', to: 'metered', model: 'gpt/plan-model' }] as const;
    const config = gatewayConfigOf({ models: new Map(), chains: new Map(), start: undefined, roles: {}, billingChanges });
    expect(config.models.billingChanges).toEqual([{ from: 'plan', to: 'metered', model: 'gpt/plan-model' }]);
  });
});
