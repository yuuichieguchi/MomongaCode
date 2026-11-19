import { describe, expect, it } from 'vitest';
import { gatewayConfigOf } from '@momonga/gateway';

describe('models.billingChanges of the user settings reaches the gateway config (P5a-w, M9)', () => {
  it('carries the resolved pairs into GatewayConfig.models.billingChanges', () => {
    const billingChanges = [{ from: 'plan', to: 'metered', model: 'gpt/plan-model' }] as const;
    const config = gatewayConfigOf({ models: new Map(), chains: new Map(), start: undefined, roles: {}, billingChanges, efforts: new Map() });
    expect(config.models.billingChanges).toEqual([{ from: 'plan', to: 'metered', model: 'gpt/plan-model' }]);
  });

  it('gives each model the effort it starts with: its own saved level, else models.effort', () => {
    const models = new Map([['a/one', {}], ['a/two', {}]]) as unknown as Parameters<typeof gatewayConfigOf>[0]['models'];
    const config = gatewayConfigOf({ models, chains: new Map(), start: undefined, roles: {}, billingChanges: [], effort: 'low', efforts: new Map([['a/one', 'xhigh']]) });
    expect(config.models.efforts).toEqual({ 'a/one': 'xhigh', 'a/two': 'low' });
  });
});
