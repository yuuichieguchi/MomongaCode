import { RequestError } from '@agentclientprotocol/sdk';
import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import { freshHome } from './fresh-home.ts';
import { runView } from './fake-backend.ts';
import { RUN_STOPPED_CODE, stopReasonOf } from '../src/acp/stop-reason.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { describeEnd, resultOf } from '../src/run/headless.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { NO_HELPER } from './no-helper.ts';

const seen = vi.hoisted(() => ({ headless: [] as Record<string, unknown>[] }));

vi.mock('../src/run/headless.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/run/headless.ts')>();
  return {
    ...original,
    runHeadless: async (_ports: unknown, _paths: unknown, options: Record<string, unknown>) => {
      seen.headless.push(options);
      return 0;
    },
  };
});

const harness = () => {
  const out: string[] = [];
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const ports = { version: '9.9.9', interrupt: new AbortController().signal, home: freshHome(), cwd: '/c', env: {}, platform: process.platform, terminal: {} } as unknown as CliPorts;
  const program = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { executables: '/c/cache/executables' }),
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  program.exitOverride().configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => out.push(text) });
  return { program, out };
};

const run = (program: ReturnType<typeof harness>['program'], ...args: string[]): Promise<unknown> => program.parseAsync(args, { from: 'user' });

const unmet = () => runView({ id: 'run-9', status: 'STOPPED', stopReason: 'conditions_unmet' as never });

describe('--until and --require on momonga -p', () => {
  it('fill the completion of the mandate of the headless run, in the given order', async () => {
    seen.headless.length = 0;
    await run(harness().program, '-p', 'fix it', '--until', 'npm test', '--until', 'npm run lint', '--require', 'the docs mention it');
    expect(seen.headless).toHaveLength(1);
    expect(seen.headless[0]).toMatchObject({
      prompt: 'fix it',
      mandate: { completion: { conditions: [{ command: 'npm test' }, { command: 'npm run lint' }], requirements: ['the docs mention it'] } },
    });
  });

  it('leave the run without a mandate when neither is given', async () => {
    seen.headless.length = 0;
    await run(harness().program, '-p', 'hello');
    expect(seen.headless[0]?.['mandate']).toBeUndefined();
    await run(harness().program, '-p', 'fix it', '--until', 'true');
    expect(seen.headless[1]?.['mandate']).toBeDefined();
  });
});

describe('--mandate and --max-cost-usd on momonga -p', () => {
  it('name the mandate of the user settings and the money limit of the run', async () => {
    seen.headless.length = 0;
    await run(harness().program, '-p', 'ship it', '--mandate', 'nightly', '--max-cost-usd', '2.5', '--until', 'npm test');
    expect(seen.headless[0]).toMatchObject({ mandate: { profile: 'nightly', completion: { conditions: [{ command: 'npm test' }] } }, limits: { maxCostUsd: 2.5 } });
    await run(harness().program, '-p', 'ship it', '--mandate', 'nightly');
    expect(seen.headless[1]?.['mandate']).toEqual({ profile: 'nightly' });
    expect(seen.headless[1]?.['limits']).toBeUndefined();
  });

  it('refuse an amount that is not a number of dollars', async () => {
    await expect(run(harness().program, '-p', 'ship it', '--max-cost-usd', 'lots')).rejects.toThrow();
  });
});

describe('momonga report', () => {
  it('is a command', () => {
    const { program } = harness();
    expect(program.commands.map((command) => command.name())).toContain('report');
  });
});

describe('the end of a headless run that stopped with unmet conditions', () => {
  it('is an error result carrying the stop reason and the run report', () => {
    const report = { runId: 'run-9', status: 'STOPPED', conditions: [{ id: 'a', command: 'npm test', state: 'failed', rounds: 2 }], notRun: [], residualRisk: [] };
    const result = resultOf({ ...unmet(), report } as never, 'done');
    expect(result).toMatchObject({ subtype: 'error', is_error: true, stop_reason: 'conditions_unmet' });
    expect((result as unknown as { report?: unknown }).report).toEqual(report);
    expect(describeEnd(unmet())).toContain('conditions_unmet');
  });
});

describe('the ACP mapping of conditions_unmet', () => {
  it('fails the prompt with the run-stopped error, because ACP has no stop reason for unmet conditions', () => {
    const failure = (() => {
      try {
        return stopReasonOf(unmet());
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(RequestError);
    expect(failure).toMatchObject({ code: RUN_STOPPED_CODE, data: { runId: 'run-9', status: 'STOPPED', stopReason: 'conditions_unmet' } });
  });
});
