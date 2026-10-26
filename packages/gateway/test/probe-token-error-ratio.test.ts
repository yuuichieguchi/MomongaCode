import { describe, expect, it } from 'vitest';
import { capabilitiesFromProbe } from '@momonga/gateway';
import type { Capabilities } from '@momonga/protocol';
import { makeReport } from './report-fixture.ts';

describe('capabilitiesFromProbe and the token error ratio', () => {
  it('carries the calibration error bound as tokenErrorRatio', () => {
    const report = makeReport(1, 1);
    report.tokenCalibration = { ratio: 1.1, errorBound: 0.07 };
    const capabilities: Capabilities = capabilitiesFromProbe(report, { mode: 'native' });
    expect(capabilities.tokenCounting).toBe('calibrated');
    expect(capabilities.tokenErrorRatio).toBe(0.07);
  });

  it('leaves tokenErrorRatio absent without a calibration', () => {
    const report = makeReport(1, 1);
    delete report.tokenCalibration;
    const capabilities = capabilitiesFromProbe(report, { mode: 'native' });
    expect(capabilities.tokenCounting).toBe('estimated');
    expect(capabilities).not.toHaveProperty('tokenErrorRatio');
  });
});
