import { describe, expect, it } from 'vitest';
import type { Capabilities, ConstructSupport, ProbeReport } from '@momonga/protocol';
import { createProbedEndpointTarget } from '../src/probe/endpoint-target.ts';
import type { ProbedEndpointTargetOptions } from '../src/probe/endpoint-target.ts';
import { CC_CAPABILITIES } from './cc-support.ts';
import { makeReport } from './report-fixture.ts';

const CONSTRUCTS: ConstructSupport = { ref: 'refused', typeArray: 'accepted', mixedEnum: 'accepted' };

const { schemaDialect: _declaredDialect, ...UNDECLARED } = CC_CAPABILITIES;

const reportOf = (schemaDialect: ProbeReport['schemaDialect'], constructSupport?: ConstructSupport): ProbeReport =>
  ({ ...makeReport(1, 1), schemaDialect, ...(constructSupport === undefined ? {} : { constructSupport }) }) as ProbeReport;

const SELECTED_EXPLICIT = reportOf({ selected: 'explicit-keys', shape: 'union', tried: [{ id: 'explicit-keys', result: 'accepted' }] }, CONSTRUCTS);
const SELECTED_2020 = reportOf({ selected: 'json-schema-2020-12', shape: 'union', tried: [{ id: 'json-schema-2020-12', result: 'accepted' }] });

const targetOf = (targetName: string, declared: Partial<Capabilities>, report: ProbeReport | null) =>
  createProbedEndpointTarget({
    targetName,
    endpoint: 'unix:/nowhere',
    model: 'm',
    declared: declared as ProbedEndpointTargetOptions['declared'],
    record: report === null ? null : { identity: 'id', identityFields: [], report },
    readIdentity: async () => 'id',
    saveRecord: async () => undefined,
  });

describe('one resolution of the dialect id: declared, else the record, else json-schema-2020-12 (rule 5)', () => {
  it('takes the probe selection when nothing is declared', async () => {
    const target = targetOf('remote', UNDECLARED, SELECTED_EXPLICIT);
    expect(target.schemaDialect()).toBe('explicit-keys');
    expect((await target.capabilities()).schemaDialect).toBe('explicit-keys');
  });

  it('hands the recorded construct table to the adapter beside the keyword table', () => {
    const target = targetOf('remote', UNDECLARED, SELECTED_EXPLICIT) as ReturnType<typeof targetOf> & { constructSupport: () => ConstructSupport | undefined };
    expect(target.constructSupport()).toEqual(CONSTRUCTS);
    const unmeasured = targetOf('remote', UNDECLARED, SELECTED_2020) as typeof target;
    expect(unmeasured.constructSupport()).toBeUndefined();
  });

  it('resolves two targets of different names behind the same record to the same id, whatever the name', async () => {
    const named = await targetOf('fm', UNDECLARED, SELECTED_2020).capabilities();
    const other = await targetOf('lmstudio', UNDECLARED, SELECTED_2020).capabilities();
    expect(named.schemaDialect).toBe('json-schema-2020-12');
    expect(other.schemaDialect).toBe('json-schema-2020-12');
    expect((await targetOf('fm', UNDECLARED, SELECTED_EXPLICIT).capabilities()).schemaDialect).toBe('explicit-keys');
  });

  it('keeps a declared dialect the probe accepted', async () => {
    const report = reportOf({ selected: 'strict-closed', shape: 'union', tried: [{ id: 'strict-closed', result: 'accepted' }] });
    const target = targetOf('remote', { ...UNDECLARED, schemaDialect: 'strict-closed' }, report);
    expect(target.schemaDialect()).toBe('strict-closed');
    expect((await target.capabilities()).schemaDialect).toBe('strict-closed');
  });

  it('resolves an unprobed target without a declaration to json-schema-2020-12', async () => {
    expect((await targetOf('remote', UNDECLARED, null).capabilities()).schemaDialect).toBe('json-schema-2020-12');
  });
});

describe('an auto target whose declared dialect the probe refused (decision b)', () => {
  const refused = reportOf({ selected: null, shape: null, tried: [{ id: 'strict-closed', result: 'refused', detail: 'Invalid schema: additionalProperties' }] });

  it('carries a precondition state naming the refused dialect and the probe remedy instead of a tool-calling mode', async () => {
    const capabilities = await targetOf('remote', { ...UNDECLARED, schemaDialect: 'strict-closed' }, refused).capabilities();
    expect(typeof capabilities.toolCalling).toBe('object');
    const state = capabilities.toolCalling as { message: string; evidence: string; remedy: string };
    expect(state.message).toContain('strict-closed');
    expect(`${state.message} ${state.evidence}`).toContain('Invalid schema: additionalProperties');
    expect(state.remedy).toBe('run `momonga gateway probe remote`');
  });
});
