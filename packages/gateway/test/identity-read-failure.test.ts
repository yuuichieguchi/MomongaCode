import { describe, expect, it } from 'vitest';
import { OutboundConnectionError } from '@momonga/foundation';
import type { OllamaProbeReport, Probing } from '@momonga/protocol';
import { createProbedEndpointTarget } from '../src/probe/endpoint-target.ts';
import { createProbedOllamaTarget } from '../src/probe/ollama-target.ts';
import { CC_CAPABILITIES } from './cc-support.ts';
import { makeReport } from './report-fixture.ts';
import { probingAnswer } from './fm-record-support.ts';

const OLLAMA_REPORT: OllamaProbeReport = {
  kind: 'ollama',
  probedAt: '2026-10-23T00:00:00.000Z',
  serverVersion: '0.12.0',
  modelId: 'devstral-small-2',
  contextWindow: { value: 12288, method: 'reported' },
  nativeTools: { accepted: true },
  imageInputAccepted: false,
  thinkingSupported: false,
  schemaDialect: { selected: null, shape: null, tried: [] },
};

const refused = (): OutboundConnectionError => new OutboundConnectionError({ kind: 'origin-connection', origin: 'http://203.0.113.9:11434', code: 'ECONNREFUSED' });

type Read = () => Promise<string | undefined>;

const scripted = (reads: Read[]): Read => async () => {
  const next = reads.shift();
  if (next === undefined) throw new Error('no identity read was scripted for this call');
  return next();
};

const probeCounter = () => {
  const started: Probing[] = [];
  const startProbe = async (): Promise<Probing> => {
    const probing = probingAnswer();
    started.push(probing);
    return probing;
  };
  return { started, startProbe };
};

const chatTarget = (reads: Read[]) => {
  const probes = probeCounter();
  const record = { identity: 'recorded', identityFields: ['id'], report: makeReport(1, 1) };
  const read = scripted(reads);
  const target = createProbedEndpointTarget({ written: {},
    toolCalling: 'auto', readReported: async () => ({}), displayOf: () => 'remote',
    endpoint: 'tcp:http://203.0.113.9:8080',
    model: 'm',
    declared: CC_CAPABILITIES,
    record,
    readRecord: async () => record,
    startProbe: probes.startProbe,
    readIdentity: async () => {
      const identity = await read();
      if (identity === undefined) throw new Error('a chat-completions identity is always a string');
      return identity;
    },
    saveRecord: async () => undefined,
  });
  return { target, probes };
};

const ollamaTarget = (reads: Read[]) => {
  const probes = probeCounter();
  const record = { identity: 'recorded', identityFields: [], report: OLLAMA_REPORT };
  const target = createProbedOllamaTarget({ written: {},
    toolCalling: 'auto', readReported: async () => ({}), displayOf: () => 'local',
    endpoint: 'tcp:http://203.0.113.9:11434',
    model: 'devstral-small-2',
    declared: CC_CAPABILITIES,
    record,
    readRecord: async () => record,
    startProbe: probes.startProbe,
    readDigest: scripted(reads),
  });
  return { target, probes };
};

const ADAPTERS = [
  ['chat-completions', chatTarget],
  ['ollama', ollamaTarget],
] as const;

describe.each(ADAPTERS)('P6 RecordMatchesKey: an identity read that failed is neither a match nor a mismatch (%s)', (_adapter, targetOf) => {
  it('fails the request with the labelled connection error, starts no probe and reads again at the next use', async () => {
    const { target, probes } = targetOf([async () => { throw refused(); }, async () => 'recorded']);

    await expect(target.verify(new AbortController().signal)).rejects.toBeInstanceOf(OutboundConnectionError);
    expect(probes.started).toEqual([]);
    await expect(target.verify(new AbortController().signal)).resolves.toBeUndefined();
    expect(probes.started).toEqual([]);
  });

  it('keeps no identity from an earlier read once a read fails, so the failure starts no probe as a changed key', async () => {
    const { target, probes } = targetOf([async () => 'another', async () => { throw refused(); }]);

    await expect(target.verify(new AbortController().signal)).rejects.toThrow();
    expect(probes.started).toHaveLength(1);
    await expect(target.verify(new AbortController().signal)).rejects.toBeInstanceOf(OutboundConnectionError);
    await target.capabilities();

    expect(probes.started).toHaveLength(1);
  });
});
