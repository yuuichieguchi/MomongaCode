import { describe, expect, it } from 'vitest';
import { buildYieldReport, runYieldDataset } from '@momonga/eval';
import type { EvalRunApi, YieldCandidate, YieldPorts } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { publicEventsOf, RECORDED_CODE_DIGEST, RESOLVED_ON_POLICY } from './fixtures.ts';
import { FAMILY_IDS, REAL_TARGET, anchorOf, family, fourFamilies, modelCall, reflectionCharge, yieldDatasetOf } from './yield-fixtures.ts';

type Opened = { family: string; arm: string; from: string; cwd: string };

const harness = (candidatesFor: (familyId: string) => YieldCandidate[]) => {
  const log: string[] = [];
  const opened: Opened[] = [];
  const seeded: { cwd: string; memory: unknown }[] = [];
  const sessions: { cwd: string; permissionMode: string; model?: string }[] = [];
  const steps: string[] = [];
  let homes = 0;
  let runs = 0;
  const apiFor = (cwd: string): EvalRunApi => ({
    costs: async () => [],
    createSession: async (input) => {
      sessions.push({ cwd: input.cwd, permissionMode: input.permissionMode, ...(input.model === undefined ? {} : { model: input.model }) });
      return { id: `s-${cwd}` };
    },
    createRun: async (_sessionId, input) => {
      runs += 1;
      log.push(`run ${cwd}: ${input.input}`);
      return { id: `r${runs}` };
    },
    events: async function* () {
      for (const event of publicEventsOf([modelCall({ cost: 0.01, cached: 400 })])) yield event;
    },
    reflectionOf: async () => ({ state: 'done', charges: [reflectionCharge(0.003)] }),
    answeredBy: async () => [REAL_TARGET],
    getRun: async (runId) => ({ id: runId, status: 'COMPLETED', step: 1, usage: { inputTokens: 9, outputTokens: 1, totalTokens: 10 }, model: 'p/m' }),
    resolveApproval: async () => undefined,
    cancelRun: async () => undefined,
  });
  const ports: YieldPorts = {
    model: 'p/m',
    policy: {},
    codeDigest: RECORDED_CODE_DIGEST,
    openLearn: async (entry) => {
      homes += 1;
      const cwd = `/learn/${entry.id}`;
      log.push(`open learn ${entry.id}`);
      return {
        cwd,
        api: apiFor(cwd),
        candidatesOf: async () => candidatesFor(entry.id),
        applyStep: async (step) => void steps.push(`${entry.id} ${JSON.stringify(step)}`),
        close: async () => void log.push(`close learn ${entry.id}`),
      };
    },
    openReuse: async (entry, arm, learn) => {
      homes += 1;
      const cwd = `/reuse/${entry.id}/${arm}`;
      opened.push({ family: entry.id, arm, from: learn.cwd, cwd });
      log.push(`open ${arm} ${entry.id}`);
      return {
        cwd,
        api: apiFor(cwd),
        seedMemory: async (memory) => {
          seeded.push({ cwd, memory });
          return { id: `mem-${seeded.length}` };
        },
        close: async () => void log.push(`close ${arm} ${entry.id}`),
      };
    },
  };
  return { ports, log, opened, seeded, sessions, steps, homes: () => homes };
};

const mixed = (id: string): YieldCandidate[] => [
  { text: `The value is ${anchorOf(id)}.`, paths: ['notes.txt'] },
  { text: 'The check passes.', paths: [] },
];

describe('the arms of a yield family', () => {
  it('seeds exactly the accepted candidates in the with arm and none in the without arm', async () => {
    const context = harness(mixed);
    const runs = await runYieldDataset(fourFamilies(), context.ports);
    expect(context.seeded).toEqual(FAMILY_IDS.map((id) => ({ cwd: `/reuse/${id}/with`, memory: { text: `The value is ${anchorOf(id)}.`, paths: ['notes.txt'] } })));
    expect(runs.map((run) => run.with?.seeded)).toEqual([['mem-1'], ['mem-2'], ['mem-3'], ['mem-4']]);
    expect(runs.map((run) => [run.candidates.length, run.accepted.length])).toEqual(FAMILY_IDS.map(() => [2, 1]));
  });

  it('starts both arms from the workspace of the same learn session, after the learn run, with the same model', async () => {
    const context = harness(mixed);
    await runYieldDataset(fourFamilies(), context.ports);
    expect(context.opened.filter((entry) => entry.family === 'port')).toEqual([
      { family: 'port', arm: 'without', from: '/learn/port', cwd: '/reuse/port/without' },
      { family: 'port', arm: 'with', from: '/learn/port', cwd: '/reuse/port/with' },
    ]);
    const ofPort = context.log.filter((line) => line.includes('port'));
    expect(ofPort.indexOf('run /learn/port: Find the value for port and run the check.')).toBeLessThan(ofPort.indexOf('open without port'));
    expect(ofPort.indexOf('open with port')).toBeLessThan(ofPort.indexOf('close learn port'));
    expect(new Set(context.sessions.map((session) => session.model))).toEqual(new Set(['p/m']));
    expect(context.log.filter((line) => line.startsWith('run /reuse/port/'))).toEqual(['run /reuse/port/without: Report the value for port.', 'run /reuse/port/with: Report the value for port.']);
  });

  it('applies the workspace steps of the family to the learn workspace before the arms are opened', async () => {
    const stepped = family('port');
    const dataset = yieldDatasetOf([
      { ...stepped, learn: { ...(stepped['learn'] as Record<string, unknown>), workspace: [{ beforeRun: 1, remove: ['notes.txt'] }] } },
      ...FAMILY_IDS.slice(1).map((id) => family(id)),
    ]);
    const context = harness(mixed);
    await runYieldDataset(dataset, context.ports);
    expect(context.steps).toEqual(['port {"beforeRun":1,"remove":["notes.txt"]}']);
  });

  it('records the transcripts of the three sessions with the policy and the code digest of the run', async () => {
    const context = harness(mixed);
    const [first] = await runYieldDataset(fourFamilies(), context.ports);
    expect([first?.learn.caseId, first?.without.caseId, first?.with?.transcript.caseId]).toEqual(['port.learn', 'port.without', 'port.with']);
    expect(first?.learn.reflection).toEqual({ state: 'done', charges: [reflectionCharge(0.003)] });
    for (const transcript of [first?.learn, first?.without, first?.with?.transcript]) {
      expect(transcript?.policy).toEqual(RESOLVED_ON_POLICY);
      expect(transcript?.codeDigest).toBe(RECORDED_CODE_DIGEST);
      expect(transcript?.answeredBy).toEqual([REAL_TARGET]);
    }
  });

  it('runs one reuse session for a family with nothing accepted and reports saving 0 and nothingAccepted', async () => {
    const context = harness((id) => (id === 'port' ? [{ text: 'The check passes.', paths: [] }] : mixed(id)));
    const dataset = fourFamilies();
    const runs = await runYieldDataset(dataset, context.ports);
    expect(context.opened.filter((entry) => entry.family === 'port').map((entry) => entry.arm)).toEqual(['without']);
    expect(context.homes()).toBe(2 + 3 * 3);
    expect(runs[0]?.with).toBeUndefined();
    const report = buildYieldReport({ dataset, runs, seed: 7 });
    const [port, codename] = report.families;
    expect(port).toMatchObject({ id: 'port', nothingAccepted: true, saving: 0, recalledAccepted: 0, contributed: 0 });
    expect(port).not.toHaveProperty('breakEvenReuses');
    expect(port?.reuse.with).toEqual(port?.reuse.without);
    expect(codename?.nothingAccepted).toBe(false);
  });

  it('continues every session that asks about a call whose effect is unknown, by the ask rule of the session', async () => {
    const context = harness(mixed);
    const resolved: { runId: string; approvalId: string; optionId: string }[] = [];
    const cancelled: string[] = [];
    const asking = (api: EvalRunApi): EvalRunApi => ({
      ...api,
      events: async function* (runId) {
        let first = true;
        for await (const event of api.events(runId)) {
          if (first) {
            yield { ...event, type: 'tool.unknown.requested', approvalId: `unknown-${runId}`, callIds: ['c1'], options: [{ optionId: 'continue', name: 'Continue', kind: 'allow_once' }], subjectDigest: 'd' } as unknown as PublicRunEvent;
          }
          first = false;
          yield event;
        }
      },
      resolveApproval: async (approvalId, optionId) => {
        resolved.push({ runId: approvalId.slice('unknown-'.length), approvalId, optionId });
      },
      cancelRun: async (runId) => {
        cancelled.push(runId);
      },
    });
    const ports: YieldPorts = {
      ...context.ports,
      openLearn: async (entry) => {
        const host = await context.ports.openLearn(entry);
        return { ...host, api: asking(host.api) };
      },
      openReuse: async (entry, arm, learn) => {
        const host = await context.ports.openReuse(entry, arm, learn);
        return { ...host, api: asking(host.api) };
      },
    };
    await runYieldDataset(fourFamilies(), ports);
    expect(resolved).toEqual(Array.from({ length: 12 }, (_unused, index) => `r${index + 1}`).map((runId) => ({ runId, approvalId: `unknown-${runId}`, optionId: 'continue' })));
    expect(cancelled).toEqual([]);
  });

  it('closes every home it opened when a reuse session fails', async () => {
    const context = harness(mixed);
    const failing: YieldPorts = {
      ...context.ports,
      openReuse: async (entry, arm, learn) => {
        const host = await context.ports.openReuse(entry, arm, learn);
        if (arm === 'with') return { ...host, seedMemory: async () => Promise.reject(new Error('the memory was refused')) };
        return host;
      },
    };
    await expect(runYieldDataset(fourFamilies(), failing)).rejects.toThrow('the memory was refused');
    expect(context.log.filter((line) => line.startsWith('close'))).toEqual(['close without port', 'close with port', 'close learn port']);
  });
});
