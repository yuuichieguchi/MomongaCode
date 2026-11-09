import { describe, expect, it } from 'vitest';
import { TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { MomongaModelEntry } from '@momonga/protocol';
import { formatModels } from '../src/commands/models.ts';

describe('the model list of an alias the gateway is measuring', () => {
  it('shows that the model is being measured once per model and OS build, and no capability numbers', () => {
    const entry: MomongaModelEntry = {
      id: 'default',
      object: 'model',
      targets: ['fm'],
      targetCounters: { fm: '1'.repeat(64) },
      capabilities: { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 }, source: 'unprobed' },
      targetCapabilities: { fm: { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 }, source: 'unprobed' } },
    };

    const text = formatModels([entry]);

    expect(text).toContain('default  -> fm');
    expect(text).toContain(TARGET_PROBING_MESSAGE);
    expect(text).not.toContain('context window');
  });
});
