import { describe, expect, it } from 'vitest';
import { createScriptedAdapter } from '@momonga/testkit';
import { getJson, postJson, startGateway, userInput } from './gateway-helpers.ts';

describe('breaker accounting for non-retryable rejections', () => {
  it('still opens on alternating 5xx and 400 responses', async () => {
    const statuses = [500, 400, 500, 400, 500];
    const primary = createScriptedAdapter({ calls: statuses.map((status) => ({ failure: { status, message: `s${status}` } })) });
    const { client } = await startGateway({
      adapters: { 'scripted/scripted-primary': primary },
      config: { retry: { maxAttempts: 1, totalWaitMs: 1 }, breaker: { failureThreshold: 3, openMs: 30_000 } },
    });
    for (let index = 0; index < statuses.length; index += 1) {
      const response = await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') });
      await response.text();
    }
    expect((await getJson(client, '/v1/momonga/health')).body.models['scripted/scripted-primary'].breaker).toBe('open');
  });
});
