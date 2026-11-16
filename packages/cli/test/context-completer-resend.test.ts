import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENERATION_RETIRED_CODE, GENERATION_RETIRED_STATUS, ensureMomongaDirs, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import { messageEvents, openResponsesErrorReply, openResponsesStream, openingEvents, registerCleanup, terminalEvent, startFakeOpenResponses, testKernelLock, usageOf, withTempDir } from '@momonga/testkit';
import type { ChainCapabilities } from '@momonga/protocol';
import { completerFor } from '../src/commands/context.ts';
import type { CliPorts } from '../src/ports.ts';

const RETIRED_TEXT = 'This gateway belongs to a replaced generation and takes no new requests. The request was not run; send it again.';
const REPLY = { verdict: 'kept' };
const CAPABILITIES = { contextWindow: 32768, maxOutputTokens: 4096 } as unknown as ChainCapabilities;
const gatewayTextReply = (text: string) => {
  const message = messageEvents([text]);
  return openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'completed', usage: usageOf(10, 5) }, [message.item])], { done: false });
};

const REQUEST = { purpose: 'analysis', instructions: 'judge', input: 'the transcript', format: { type: 'json_schema', name: 'verdict', strict: true, schema: { type: 'object' } } } as const;

describe('the guideline completer of context improve and a retired gateway generation (P-134)', () => {
  it('sends the same request once more when the gateway answers generation_retired, and returns the answer of the second send', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const gateway = await startFakeOpenResponses({
      socketPath: path.join(paths.run, 'g.sock'),
      script: [openResponsesErrorReply(GENERATION_RETIRED_STATUS, 'server_error', GENERATION_RETIRED_CODE, RETIRED_TEXT), gatewayTextReply(JSON.stringify(REPLY))],
    });
    registerCleanup(context, () => gateway.close());
    const sockets = { runtime: path.join(paths.run, 'r.sock'), gateway: gateway.socketPath, supervisor: path.join(paths.run, 's.sock') };
    expect(await publishCurrentGeneration(paths, { generation: 1, version: '9.9.9', sockets }, { lock: testKernelLock() })).toBe('published');
    let now = 0;
    const ports = { version: '9.9.9', clock: { now: () => (now += 1), sleep: async () => undefined }, uuid: () => 'key-1' } as unknown as CliPorts;
    const completer = await completerFor(ports, paths, 'fake/model', CAPABILITIES, new AbortController().signal);
    registerCleanup(context, () => completer.close());

    const completion = await completer.complete(REQUEST);

    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]?.body).toEqual(gateway.requests[0]?.body);
    expect(completion.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(JSON.stringify(completion)).toContain('kept');
  });
});
