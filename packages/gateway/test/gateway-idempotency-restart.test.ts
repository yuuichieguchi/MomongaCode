import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { makeDir, outputText, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const body = { model: 'fast', input: userInput('hi') };
const key = { 'idempotency-key': 'k-restart' };

describe('a stored response across a gateway restart with other target settings', () => {
  it('replays the frames stored before the restart under the same key, without calling the new target', async () => {
    const dir = makeDir();
    const before = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['from the old settings'], usage: usageOf(9, 3) }) }] });
    const first = await startGateway({ adapters: { primary: before }, dir, config: { targets: { primary: { model: 'scripted-primary' } } } });
    const stored = await readJson(await postJson(first.client, '/v1/responses', body, key));
    await first.gateway.close();

    const after = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'scripted-primary-v2', chunks: ['from the new settings'], usage: usageOf(9, 3) }) }] });
    const second = await startGateway({ adapters: { primary: after }, dir, config: { targets: { primary: { model: 'scripted-primary-v2', maxConcurrency: 7 } } } });
    const replayed = await readJson(await postJson(second.client, '/v1/responses', body, key));

    expect(stored.status).toBe(200);
    expect(replayed.status).toBe(200);
    expect(after.calls).toHaveLength(0);
    expect(outputText(replayed.body)).toBe('from the old settings');
    expect(replayed.body.momonga).toEqual(stored.body.momonga);
  });
});
