import { describe, expect, it } from 'vitest';
import type { ProbeReport } from '@momonga/protocol';
import { capabilitiesFromProbe, decideToolCalling } from '../src/probe/decide.ts';
import { makeReport } from './report-fixture.ts';

const honoursNoBound: ProbeReport = { ...makeReport(1, 1), outputBoundField: 'none' };

describe('a probed none output bound becomes a capability behind context.unboundedOutputReserve (P2 item 7, D12)', () => {
  it('records outputBoundField none when the setting is on', () => {
    const capabilities = capabilitiesFromProbe(honoursNoBound, decideToolCalling(honoursNoBound), {}, { unboundedOutputReserve: true });
    expect(capabilities.outputBoundField).toBe('none');
  });

  it('keeps dropping the probed none when the setting is off, so no existing target changes', () => {
    const on = capabilitiesFromProbe(honoursNoBound, decideToolCalling(honoursNoBound), {}, { unboundedOutputReserve: true });
    const off = capabilitiesFromProbe(honoursNoBound, decideToolCalling(honoursNoBound), {}, { unboundedOutputReserve: false });
    expect(off).not.toHaveProperty('outputBoundField');
    expect(on.outputBoundField).toBe('none');
    const { outputBoundField: _dropped, ...onWithoutBound } = on;
    expect(onWithoutBound).toEqual(off);
  });
});
