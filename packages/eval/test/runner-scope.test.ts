import { describe, expect, it } from 'vitest';
import { DATASET_FORMAT, runDataset } from '@momonga/eval';
import type { EvalRunApi, EvalSessionInput, GoldenCase, GoldenDataset } from '@momonga/eval';
import { goldenCase } from './fixtures.ts';

type Scope = { api: EvalRunApi; workspace: { cwd: string; env: Record<string, string> }; close(): Promise<void> };

type OpenPorts = { open(golden: GoldenCase, runIndex: number): Promise<Scope>; model?: string };

const apiFor = (label: string, log: string[], sessions: EvalSessionInput[], failRun = false): EvalRunApi => ({
  costs: async () => [],
  createSession: async (input) => {
    sessions.push(input);
    log.push(`session ${label}`);
    return { id: `s-${label}` };
  },
  createRun: async () => {
    log.push(`run ${label}`);
    if (failRun) throw new Error('the run could not start');
    return { id: `r-${label}` };
  },
  events: async function* () {},
  getRun: async (runId) => ({ id: runId, sessionId: `s-${label}`, status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }) as never,
  reflectionOf: async () => ({ state: 'none' }),
  resolveApproval: async () => undefined,
  answeredBy: async () => [],
  cancelRun: async () => undefined,
});

const dataset = (runs: number): GoldenDataset => ({ format: DATASET_FORMAT, name: 'scoped', cases: [goldenCase({ id: 'answer', runs, graders: [{ kind: 'status', equals: 'COMPLETED' }] })] });

const run = (ports: OpenPorts, runs: number) => runDataset(dataset(runs), ports as unknown as Parameters<typeof runDataset>[1]);

describe('a dataset run opens one scope per run and closes it', () => {
  it('opens a scope for each run, runs in it, and closes it before the next opens', async () => {
    const log: string[] = [];
    const sessions: EvalSessionInput[] = [];
    const opened: string[] = [];
    const ports: OpenPorts = {
      open: async (golden, runIndex) => {
        const label = `${golden.id}.${runIndex}`;
        opened.push(label);
        log.push(`open ${label}`);
        return { api: apiFor(label, log, sessions), workspace: { cwd: `/w/${label}`, env: {} }, close: async () => void log.push(`close ${label}`) };
      },
    };
    await run(ports, 2);
    expect(opened).toEqual(['answer.0', 'answer.1']);
    expect(log).toEqual(['open answer.0', 'session answer.0', 'run answer.0', 'close answer.0', 'open answer.1', 'session answer.1', 'run answer.1', 'close answer.1']);
    expect(sessions.map((session) => session.cwd)).toEqual(['/w/answer.0', '/w/answer.1']);
  });

  it('closes the scope when the run fails', async () => {
    const log: string[] = [];
    const ports: OpenPorts = {
      open: async () => ({ api: apiFor('x', log, [], true), workspace: { cwd: '/w', env: {} }, close: async () => void log.push('close x') }),
    };
    await expect(run(ports, 1)).rejects.toThrow('the run could not start');
    expect(log.at(-1)).toBe('close x');
  });

  it('passes the model of the ports to every session it creates', async () => {
    const sessions: EvalSessionInput[] = [];
    const ports: OpenPorts = {
      model: 'worker',
      open: async (golden, runIndex) => ({ api: apiFor(`${runIndex}`, [], sessions), workspace: { cwd: '/w', env: {} }, close: async () => undefined }),
    };
    await run(ports, 3);
    expect(sessions.map((session) => session.model)).toEqual(['worker', 'worker', 'worker']);
  });
});
