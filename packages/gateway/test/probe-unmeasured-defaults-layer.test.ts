import { describe, expect, it } from 'vitest';
import type { ProbeReport } from '@momonga/protocol';
import { createProbedEndpointTarget } from '../src/probe/endpoint-target.ts';
import { CC_CAPABILITIES } from './cc-support.ts';
import { makeReport } from './report-fixture.ts';
import { NO_PROBE_START } from './fm-record-support.ts';

const { schemaDialect: _declaredDialect, ...UNDECLARED } = CC_CAPABILITIES;

const UNMEASURED_DEFAULTS = { ...UNDECLARED, structuredOutput: 'none', streaming: true, stopSequences: true, tokenCounting: 'estimated', usageReported: true } as const;

const MEASURED_OTHERWISE: ProbeReport = { ...makeReport(1, 1), streaming: { supported: false }, stopSequences: false, usageReported: false } as ProbeReport;

const targetOf = (written: Record<string, unknown>, report: ProbeReport | null, toolCalling: 'auto' | 'native' = 'auto') =>
  createProbedEndpointTarget({
    toolCalling,
    readReported: async () => ({}),
    targetName: 'remote',
    endpoint: 'unix:/nowhere',
    model: 'm',
    declared: UNMEASURED_DEFAULTS,
    written,
    record: report === null ? null : { identity: 'id', identityFields: [], report },
    readRecord: async () => (report === null ? null : { identity: 'id', identityFields: [], report }),
    startProbe: NO_PROBE_START,
    readIdentity: async () => 'id',
    saveRecord: async () => undefined,
  });

describe('an unmeasured default is the lowest layer: a measured value wins over it', () => {
  it('takes the measured value of a field the person did not write, over the default', async () => {
    const capabilities = await targetOf({}, MEASURED_OTHERWISE).capabilities();
    expect(capabilities).toMatchObject({ streaming: false, stopSequences: false, usageReported: false });
  });

  it('keeps the default for a field no source gives, when nothing is written and no record exists', async () => {
    const capabilities = await targetOf({}, null, 'native').capabilities();
    expect(capabilities).toMatchObject({ streaming: true, stopSequences: true, usageReported: true, tokenCounting: 'estimated' });
  });

  it('keeps the value the person wrote over the measured one', async () => {
    const capabilities = await targetOf({ streaming: true }, MEASURED_OTHERWISE).capabilities();
    expect(capabilities).toMatchObject({ streaming: true, stopSequences: false });
  });
});
