import { describe, expect, it } from 'vitest';
import { DATASET_FORMAT, EvalError, runDataset } from '@momonga/eval';
import type { EvalRunApi } from '@momonga/eval';
import { approvalTranscript, finalAnswerTranscript, goldenCase } from './fixtures.ts';
import type { Transcript } from '@momonga/eval';

type Scripted = { sessions: string[]; runs: string[]; resolved: { approvalId: string; optionId: string }[]; api: EvalRunApi };

const scriptedApi = (transcripts: Transcript[]): Scripted => {
  const record: Scripted = { sessions: [], runs: [], resolved: [], api: undefined as unknown as EvalRunApi };
  const byRun = new Map(transcripts.map((transcript) => [transcript.run.id, transcript]));
  const queue = [...transcripts];
  record.api = {
    createSession: async (input) => {
      record.sessions.push(input.permissionMode);
      return { id: `s${record.sessions.length}` };
    },
    createRun: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('no scripted run left');
      record.runs.push(next.run.id);
      return { id: next.run.id };
    },
    events: async function* (runId) {
      for (const event of byRun.get(runId)?.events ?? []) yield event;
    },
    getRun: async (runId) => {
      const found = byRun.get(runId);
      if (found === undefined) throw new Error(`unknown run ${runId}`);
      return found.run;
    },
    resolveApproval: async (approvalId, optionId) => {
      record.resolved.push({ approvalId, optionId });
    },
  };
  return record;
};

const workspace = async () => ({ cwd: '/w', env: { HOME: '/h' } });

describe('runDataset', () => {
  it('runs every case N times in a fresh session and reports the pass rate', async () => {
    const scripted = scriptedApi([finalAnswerTranscript('answer', 0), finalAnswerTranscript('answer', 1), finalAnswerTranscript('answer', 2)]);
    const stored: string[] = [];
    const report = await runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'answer', runs: 3, graders: [{ kind: 'finalTextEquals', text: 'hi' }] })] },
      { api: scripted.api, workspace, onTranscript: async (transcript) => void stored.push(`${transcript.caseId}.${transcript.runIndex}`) },
    );
    expect(scripted.sessions).toEqual(['default', 'default', 'default']);
    expect(stored).toEqual(['answer.0', 'answer.1', 'answer.2']);
    expect(report.cases[0]?.passRate).toMatchObject({ successes: 3, trials: 3 });
    expect(report.passed).toBe(true);
  });

  it('answers an approval request with the option of the configured kind', async () => {
    const scripted = scriptedApi([approvalTranscript('ask', 0)]);
    await runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'ask', onAsk: 'reject_once', graders: [{ kind: 'permissionDecision', tool: 'Bash', expected: 'ask' }] })] },
      { api: scripted.api, workspace },
    );
    expect(scripted.resolved).toEqual([{ approvalId: 'a1', optionId: 'reject_once' }]);
  });

  it('fails when the approval offers no option of the configured kind', async () => {
    const transcript = approvalTranscript('ask', 0);
    const events = transcript.events.map((event) =>
      event.type === 'tool.permission.requested' ? { ...event, options: event.options.filter((option) => option.kind !== 'allow_once') } : event,
    );
    const scripted = scriptedApi([{ ...transcript, events }]);
    await expect(
      runDataset(
        { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'ask', onAsk: 'allow_once', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] },
        { api: scripted.api, workspace },
      ),
    ).rejects.toThrow(EvalError);
  });

  it('lets an infrastructure failure propagate', async () => {
    const scripted = scriptedApi([]);
    await expect(
      runDataset({ format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'answer', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] }, { api: scripted.api, workspace }),
    ).rejects.toThrow('no scripted run left');
  });
});
