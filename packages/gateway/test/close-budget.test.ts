import { describe, expect, it } from 'vitest';
import { GATEWAY_MAX_CLOSE_MS } from '@momonga/foundation';
import { FM_SERVE_DEFAULTS, GATEWAY_CONFIG_DEFAULTS } from '@momonga/gateway';

describe('gateway close budget', () => {
  it('GATEWAY_MAX_CLOSE_MS pins the gateway defaults (an arithmetic pin of constants)', () => {
    expect(GATEWAY_CONFIG_DEFAULTS.closeGraceMs + FM_SERVE_DEFAULTS.stopGraceMs + 2000).toBe(GATEWAY_MAX_CLOSE_MS);
  });
});
