import { describe, expect, it } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { evaluateBench } from '../src/commands/bench.ts';
import { evaluateContext } from '../src/commands/evaluate.ts';
import { evaluateYield } from '../src/commands/yield.ts';
import type { CliPorts } from '../src/ports.ts';

const EXISTING = '/w/report.json';

const harness = () => {
  const asked: string[] = [];
  const ports = {
    cwd: '/w',
    home: '/home/person',
    platform: process.platform,
    env: {},
    interrupt: new AbortController().signal,
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    files: {
      exists: async (file: string) => file === EXISTING,
      readText: async (file: string) => {
        asked.push(`read ${file}`);
        throw new Error(`no fixture for ${file}`);
      },
      listFiles: async () => [],
    },
  } as unknown as CliPorts;
  const hostEffects = () => {
    asked.push('host');
    throw new Error('the measurement started');
  };
  return { ports, asked, hostEffects };
};

describe('an existing report file is refused before any run is made', () => {
  it('eval bench', async () => {
    const { ports, asked, hostEffects } = harness();
    await expect(evaluateBench(ports, momongaPaths('/home/person', process.platform, {}), 'bench', { validate: false, model: 'p/m', report: 'report.json', groupBy: 'model', interrupt: ports.interrupt }, hostEffects as never)).rejects.toThrow(
      `${EXISTING} already exists`,
    );
    expect(asked).toEqual([]);
  });

  it('eval context', async () => {
    const { ports, asked, hostEffects } = harness();
    await expect(evaluateContext(ports, 'context.json', { model: 'p/m', report: 'report.json', interrupt: ports.interrupt }, hostEffects as never)).rejects.toThrow(`${EXISTING} already exists`);
    expect(asked).toEqual([]);
  });

  it('eval yield', async () => {
    const { ports, asked, hostEffects } = harness();
    await expect(evaluateYield(ports, 'yield.json', { model: 'p/m', report: 'report.json', interrupt: ports.interrupt }, hostEffects as never)).rejects.toThrow(`${EXISTING} already exists`);
    expect(asked).toEqual([]);
  });
});
