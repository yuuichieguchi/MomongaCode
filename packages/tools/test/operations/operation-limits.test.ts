import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATION_SPECS, createOperationTools, parseOperationSpec } from '@momonga/tools';
import type { ToolLimits } from '@momonga/tools';
import { NO_FORGE, countingRunner } from './support.ts';

const SPEC_DIR = path.resolve(import.meta.dirname, '../../src/operations/specs');

const LIMITS: ToolLimits = {
  bash: { defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000, onTimeout: 'background', backgroundTimeoutMs: 1_800_000, maxBackgroundTimeoutMs: 7_200_000, drainIdleMs: 1000 },
  search: { timeoutMs: 60_000 },
  operations: { timeoutMs: 45_000 },
};

describe('the time limit of an operation is the setting tools.operations.timeoutMs', () => {
  it('no shipped spec carries a fixed limit', () => {
    for (const name of fs.readdirSync(SPEC_DIR).filter((file) => file.endsWith('.json'))) {
      expect(Object.keys(JSON.parse(fs.readFileSync(path.join(SPEC_DIR, name), 'utf8')) as Record<string, unknown>)).not.toContain('timeoutMs');
    }
  });

  it('a spec that carries a fixed limit is refused', () => {
    const [first] = OPERATION_SPECS;
    expect(() => parseOperationSpec({ ...first, timeoutMs: 30_000 })).toThrow(/must NOT have additional properties/);
  });

  it('every operation tool takes its limit from the setting', () => {
    for (const tool of createOperationTools({ runArgv: countingRunner().run, forge: NO_FORGE, settings: {}, platform: process.platform, shell: async () => '/bin/sh', })) {
      expect(typeof tool.timeoutMs === 'function' ? tool.timeoutMs({}, LIMITS) : tool.timeoutMs).toBe(LIMITS.operations.timeoutMs);
    }
  });
});
