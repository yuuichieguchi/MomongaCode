import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { saveProbeRecord } from '@momonga/gateway';
import type { ProbeRecordKey } from '@momonga/gateway';
import { TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Probing, ProbeReport } from '@momonga/protocol';
import { FAKE_OS_BUILD } from '@momonga/testkit';
import { makeReport } from './report-fixture.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';

export type StartProbe = (key: ProbeRecordKey) => Promise<Probing>;

export const NO_AUTO_PROBE: StartProbe = async (key) => {
  throw new Error(`this test keeps a probe record and expects no automatic probe of ${key.target}`);
};

export const NO_PROBE_START = async (): Promise<Probing> => {
  throw new Error('this test keeps a probe record and expects no automatic probe');
};

export const probingAnswer = (): Probing => ({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 });

export const IDLE_AUTO_PROBE: StartProbe = async () => probingAnswer();

export const recordKeyOptions = (key: ProbeRecordKey, startProbe: StartProbe = NO_AUTO_PROBE) => ({ target: key.target, readRecordKey: async () => key, startProbe });

export const primed = async <Managed extends { capabilities: (target: { name: string; model: string }) => Promise<unknown> }>(managed: Promise<Managed>, target: string): Promise<Managed> => {
  const ready = await managed;
  await ready.capabilities({ name: target, model: target });
  return ready;
};

export const saveFakeFmRecord = async (home: string, target: string, binaryPath: string, report: ProbeReport = makeReport(1, 1)): Promise<void> => {
  const key = { target, binarySha256: createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'), osBuild: FAKE_OS_BUILD };
  await saveProbeRecord(path.join(home, '.momonga', 'state', 'probe'), key, report, CURRENT_DIALECTS);
};
