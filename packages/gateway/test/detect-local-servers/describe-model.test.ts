import { describe, expect, it } from 'vitest';
import { SERVER_KINDS } from '@momonga/protocol';
import { endpointKeyOf, probeOllamaTarget } from '@momonga/gateway';
import { UNCONFIGURED_NETWORK, testKernelLock } from '@momonga/testkit';
import { describeModel, readModelDetails } from '../../src/detect-local-servers.ts';
import { makeDir } from '../gateway-helpers.ts';
import { OLLAMA_MODEL, TRAINED_CONTEXT_LENGTH, startFakeOllama } from '../ollama-support.ts';
import { hostProbePorts } from '../probe-ports-support.ts';
import { hostFetch } from '../detect-kinds-support.ts';

const ollamaDetails = () => {
  const details = SERVER_KINDS.find((kind) => kind.kind === 'ollama')?.read?.details;
  if (details === undefined) throw new Error('the registry has no Ollama details read');
  return details;
};

describe('the details of a served model have one reader (R1)', () => {
  it('reads the window and the tool support from one /api/show request shaped by the server kind', async () => {
    const asked: string[] = [];
    const details = await readModelDetails(
      async (method, path, body) => {
        asked.push(`${method} ${path} ${JSON.stringify(body)}`);
        return { capabilities: ['completion', 'tools', 'vision'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 } };
      },
      ollamaDetails(),
      'qwen3:8b',
    );
    expect(asked).toEqual(['POST /api/show {"model":"qwen3:8b"}']);
    expect(details).toEqual({ window: 40960, tools: 'yes', capabilities: ['completion', 'tools', 'vision'] });
  });

  it('reads no window and unknown tools from an answer without them', async () => {
    expect(await readModelDetails(async () => ({}), ollamaDetails(), 'm')).toEqual({ tools: 'unknown' });
  });

  it('gives the probe and the description of a model the same window and tools', async () => {
    const fake = await startFakeOllama();
    const { report } = await probeOllamaTarget({
      ports: hostProbePorts,
      lock: testKernelLock(),
      probeRecordDir: makeDir(),
      upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK },
      key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL },
      model: OLLAMA_MODEL,
      contextWindow: 32768,
    });
    const described = await describeModel({
      server: { kind: 'ollama', provider: 'ollama', address: fake.origin, models: [] },
      model: { id: OLLAMA_MODEL, tools: 'unknown' },
      signal: new AbortController().signal,
      fetch: hostFetch,
    });
    expect(described.ceiling).toBe(TRAINED_CONTEXT_LENGTH);
    expect(report.contextWindow.value).toBe(described.ceiling);
    expect(described.tools).toBe(report.nativeTools.accepted ? 'yes' : 'no');
  });
});
