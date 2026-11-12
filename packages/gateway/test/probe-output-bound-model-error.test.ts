import { afterEach, describe, expect, it } from 'vitest';
import { runProbe } from '@momonga/gateway';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { FM_PROBE_ROUTES } from './fm-record-support.ts';
import { hostProbePorts } from './probe-ports-support.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const FM_MODEL_ERROR = { error: { code: '500', type: 'server_error', message: 'The operation couldn’t be completed. (FoundationModels.LanguageModelError error -1.)' } };

const carriesCompletionCap = (body: unknown): boolean => typeof body === 'object' && body !== null && 'max_completion_tokens' in body;

describe('a step the server answers with its own model error (real-use-09)', () => {
  it('measures that field as not supported and goes on with the measurement, as the managed Apple model answers the output bound step', async () => {
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      outputBound: { honours: 'both' },
      routes: [{ match: carriesCompletionCap, reply: { kind: 'error', status: 200, body: FM_MODEL_ERROR } }],
    });
    servers.push(fake);

    const report = await runProbe({ ports: hostProbePorts, socketPath: fake.socketPath, managed: FM_PROBE_ROUTES, samples: 2 });

    expect(report.outputBoundField).toBe('max_tokens');
  });
});
