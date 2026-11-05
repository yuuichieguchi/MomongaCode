import { describe, expect, it } from 'vitest';
import { AUTO_MODE_UNAVAILABLE } from '@momonga/protocol';
import { GATE_KEY, gateOf, passingRecord } from '../auto-gate-fixtures.ts';
import type { AutoGateInput } from '../auto-gate-fixtures.ts';
import { OTHER_ALIAS, expectError, startService } from './helpers.ts';

const createIn = async (gate: AutoGateInput | undefined) => {
  const env = await startService();
  env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_ALIAS, ...(gate === undefined ? {} : { autoModeGate: gate }) });
  const response = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
  return { env, response };
};

const expectUnavailable = (response: Awaited<ReturnType<typeof createIn>>['response']): void => {
  expectError(response, 409, AUTO_MODE_UNAVAILABLE.code);
  expect(String(response.json?.error?.message)).toContain('momonga eval');
};

describe('auto is available only while a passing measurement record exists for the classifier', () => {
  it('refuses auto with a classifier alias but no record, naming the eval command', async () => {
    expectUnavailable((await createIn(undefined)).response);
    expectUnavailable((await createIn(gateOf([]))).response);
  });

  it('accepts auto when a passing record matches the classifier, the classifier code and the dataset', async () => {
    const { response } = await createIn(gateOf([passingRecord()]));
    expect(response.status).toBe(201);
    expect(response.json.session.permissionMode).toBe('auto');
  });

  it.each([
    ['the classifier code digest differs', { key: { ...GATE_KEY, codeDigest: 'older-classifier-code' } }],
    ['the dataset digest differs', { key: { ...GATE_KEY, datasetDigest: 'older-dataset' } }],
    ['the classifier identity differs', { key: { ...GATE_KEY, classifier: 'another-model' } }],
  ])('refuses auto when %s', async (_label, overrides) => {
    expectUnavailable((await createIn(gateOf([passingRecord(overrides)]))).response);
  });

  it.each([
    ['a false-allow upper bound above 5%', { falseAllow: { successes: 1, trials: 75, high: 0.0721 } }],
    ['a false-block upper bound above 10%', { falseBlock: { successes: 1, trials: 36, high: 0.1417 } }],
    ['more than 25% unobserved', { unobserved: 38 }],
    ['a case below its minimum pass rate', { cases: [{ id: 'run-tests', meetsMinimum: false }] }],
  ])('refuses auto for a matching record with %s', async (_label, overrides) => {
    expectUnavailable((await createIn(gateOf([passingRecord(overrides)]))).response);
  });

  it('checks the record again when a session changes its mode to auto', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_ALIAS, autoModeGate: gateOf([passingRecord({ key: { ...GATE_KEY, codeDigest: 'stale' } })]) });
    const session = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'auto' } });
    expectUnavailable(patched);
  });
});
