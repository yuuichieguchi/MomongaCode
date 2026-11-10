import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStdioTransport } from '@momonga/mcp';
import { systemTiming, type DeadlineTiming, type TerminateOutcome } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { BASE_ENV, makeDir, onCleanup, rawConfig } from './raw-transport.ts';

const elapsedStopBound: DeadlineTiming = {
  now: () => systemTiming.now(),
  setTimeout: (callback) => {
    callback();
    return undefined;
  },
  clearTimeout: () => undefined,
};

describe('mcp close sweeps its marker under the close operation signal, not the stop bound of terminateGroup (HB0 3G, HB2 rule 1)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('the marker sweep runs to completion although the stop bound of terminateGroup has already passed', async () => {
    const dir = path.join(makeDir(), 'markers');
    fs.mkdirSync(dir, { mode: 0o700 });
    const warnings: string[] = [];
    const terminateSignals: AbortSignal[] = [];
    const terminateOptionKeys: string[] = [];
    const transport = createStdioTransport({
      name: 'raw',
      config: rawConfig(),
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      closeGraceMs: 200,
      markers: { dir, onWarning: (message) => void warnings.push(message) },
      timing: elapsedStopBound,
      terminate: async (_pgid, options): Promise<TerminateOutcome> => {
        if (options.signal !== undefined) terminateSignals.push(options.signal);
        terminateOptionKeys.push(...Object.keys(options));
        return 'gone';
      },
    });
    onCleanup(() => transport.close());
    await transport.start();
    expect(fs.readdirSync(dir)).toHaveLength(1);

    await transport.close();

    expect(terminateSignals).toHaveLength(1);
    expect(terminateSignals[0]?.aborted).toBe(true);
    expect(terminateOptionKeys.sort()).toEqual(['graceMs', 'signal']);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
