import { describe, expect, it } from 'vitest';
import { endpointKeyOf } from '@momonga/config';
import type { ProbePrecondition } from '../src/probe/auto-probe.ts';
import { meteredPrecondition } from '../src/probe/consent.ts';
import { createProbedEndpointTarget } from '../src/probe/endpoint-target.ts';
import { DeclaredWindowAboveReportedError, refusingAdapter } from '../src/probe/declared-window.ts';
import type { ProviderAdapter } from '@momonga/protocol';
import { CC_CAPABILITIES } from './cc-support.ts';
import { makeDir } from './gateway-helpers.ts';
import { NO_PROBE_START } from './fm-record-support.ts';

const { schemaDialect: _declaredDialect, ...UNDECLARED } = CC_CAPABILITIES;

describe('a part reused across epochs names the model as the current epoch does', () => {
  it('names the display of the current epoch in the probe text of an endpoint part', () => {
    let display = 'first-name';
    const target = createProbedEndpointTarget({
      displayOf: () => display,
      endpoint: 'unix:/nowhere',
      model: 'm',
      declared: UNDECLARED,
      written: {},
      toolCalling: 'auto',
      record: null,
      readRecord: async () => null,
      readReported: async () => ({}),
      startProbe: NO_PROBE_START,
      readIdentity: async () => 'id',
      saveRecord: async () => undefined,
    });

    display = 'second-name';

    expect(() => target.raiseHeadroom(1)).toThrow('the model "second-name" sets toolCalling to auto, but no probe record exists');
  });

  it('names the display of the current epoch in the consent refusal of a metered part', async () => {
    let display = 'first-name';
    const passing: ProbePrecondition = { boundMs: 1000, check: async () => ({ kind: 'met' }) };
    const key = { endpoint: endpointKeyOf({ kind: 'unix', socketPath: '/nowhere.sock' }), model: 'm' };
    const precondition = meteredPrecondition(passing, makeDir(), key, { displayOf: () => display, declaredContextWindow: 1000 }, 1);

    display = 'second-name';

    const verdict = await precondition.check(new AbortController().signal);
    expect(verdict).toMatchObject({ kind: 'refused', message: expect.stringContaining('"second-name"') });
  });

  it('names the display of the current epoch in a declared-window refusal of a reused part', async () => {
    let display = 'first-name';
    const adapter = refusingAdapter({} as ProviderAdapter, () => new DeclaredWindowAboveReportedError(display, 8192, 4096, 'http://server'));

    display = 'second-name';

    await expect(adapter.capabilities({ name: 'm', display: 'm', model: 'm' })).rejects.toThrow('second-name');
  });
});
