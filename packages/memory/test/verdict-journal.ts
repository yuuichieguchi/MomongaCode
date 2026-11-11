import type { ApprovalBasis, RunEvent, SideEffect, ToolFile } from '@momonga/protocol';

export const PROJECT = '/work/a';

export type Condition = { id: string; command: string; when: 'always' | 'after_mutation'; source: 'request' | 'profile' | 'settings' };

export const standing = (command: string): Condition => ({ id: `c:${command}`, command, when: 'after_mutation', source: 'settings' });

export const requested = (command: string): Condition => ({ id: `c:${command}`, command, when: 'always', source: 'request' });

type Call = {
  step: 'call';
  name: string;
  kind: string;
  sideEffect: SideEffect;
  basis: ApprovalBasis | 'unrecorded';
  rawInput: Record<string, unknown>;
  locations?: { path: string }[];
  end: Record<string, unknown>;
  started: boolean;
  rejected?: boolean;
  mutates: boolean;
};

type Check = { step: 'check'; command: string; outcome: string; exitCode?: number; mutationSeq?: number };

export type Step = Call | Check;

export const write = (file: string): Step => ({
  step: 'call',
  name: 'Write',
  kind: 'edit',
  sideEffect: 'write',
  basis: 'rule',
  rawInput: { file_path: `${PROJECT}/${file}` },
  end: { type: 'tool.completed', status: 'completed', output: 'ok', files: [{ path: `${PROJECT}/${file}`, sha256: 'aa', access: 'write' }] satisfies ToolFile[] },
  started: true,
  mutates: true,
});

export const read = (file: string, sha256 = 'bb'): Step => ({
  step: 'call',
  name: 'Read',
  kind: 'read',
  sideEffect: 'read_only',
  basis: 'read_only',
  rawInput: { file_path: `${PROJECT}/${file}` },
  end: { type: 'tool.completed', status: 'completed', output: '', files: [{ path: `${PROJECT}/${file}`, sha256, access: 'read' }] satisfies ToolFile[] },
  started: true,
  mutates: false,
});

export type BashOptions = { basis?: ApprovalBasis | 'unrecorded'; exitCode?: number; status?: 'completed' | 'failed'; rejected?: boolean; denied?: boolean };

export const bash = (command: string, options: BashOptions = {}): Step => commandThrough('Bash', command, options);

export const commandThrough = (name: string, command: string, options: BashOptions = {}): Step => {
  const basis = options.basis ?? 'read_only';
  const started = options.denied !== true && options.rejected !== true;
  return {
    step: 'call',
    name,
    kind: 'execute',
    sideEffect: 'exec',
    basis,
    rawInput: { command },
    end: {
      type: 'tool.completed',
      status: options.status ?? 'completed',
      output: '',
      ...(options.denied === true ? { denial: { source: 'rule', message: 'no' } } : { exitCode: options.exitCode ?? 0 }),
      ...(started ? { command } : {}),
    },
    started,
    ...(options.rejected === true ? { rejected: true } : {}),
    mutates: started && basis !== 'read_only',
  };
};

export const reconciled = (step: Step, outcome: 'already_applied' | 'not_applied' | 'unknown'): Step => {
  if (step.step !== 'call') throw new Error('only a call is reconciled');
  const command = outcome === 'not_applied' ? undefined : step.end['command'];
  return { ...step, end: { type: 'tool.reconciled', outcome, output: 'interrupted', ...(command === undefined ? {} : { command }) }, mutates: step.mutates && outcome !== 'not_applied' };
};

export const check = (command: string, outcome = 'passed', mutationSeq?: number): Step => ({
  step: 'check',
  command,
  outcome,
  ...(outcome === 'passed' ? { exitCode: 0 } : outcome === 'failed' ? { exitCode: 1 } : {}),
  ...(mutationSeq === undefined ? {} : { mutationSeq }),
});

export const journal = (conditions: readonly Condition[] | undefined, steps: readonly Step[]): RunEvent[] => {
  const events: Record<string, unknown>[] = [{ type: 'run.status', from: 'QUEUED', to: 'RUNNING' }];
  events.push({
    type: 'run.started',
    attempt: 1,
    now: 1,
    pins: { ...(conditions === undefined ? {} : { mandate: { completion: { conditions, requirements: [] } } }) },
  });
  let lastMutationSeq = 0;
  for (const [index, step] of steps.entries()) {
    if (step.step === 'check') {
      const conditionId = `c:${step.command}`;
      const mutationSeq = step.mutationSeq ?? lastMutationSeq;
      events.push({ type: 'verification.started', round: index + 1, conditionId, command: step.command, mutationSeq, attempt: 1 });
      events.push({
        type: 'verification.completed',
        round: index + 1,
        conditionId,
        command: step.command,
        outcome: step.outcome,
        ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
        durationMs: 3,
        output: '',
        mutationSeq,
      });
      continue;
    }
    const callId = `t${index}`;
    events.push({
      type: 'tool.call',
      callId,
      providerCallId: callId,
      name: step.name,
      kind: step.kind,
      sideEffect: step.sideEffect,
      title: step.name,
      rawInput: step.rawInput,
      ...(step.locations === undefined ? {} : { locations: step.locations }),
    });
    if (step.rejected === true) {
      events.push({ type: 'tool.permission.requested', approvalId: `a-${callId}`, callId, options: [{ optionId: 'no', name: 'No', kind: 'reject_once' }], subjectDigest: 'd', reason: 'ask', shown: { title: 'approval', input: {} } });
      events.push({ type: 'tool.permission.resolved', approvalId: `a-${callId}`, optionId: 'no' });
    }
    if (step.started) events.push({ type: 'tool.started', callId, idemKey: `k-${callId}`, ...(step.basis === 'unrecorded' ? {} : { basis: step.basis }) });
    events.push({ ...step.end, callId });
    if (step.mutates) lastMutationSeq = events.length;
  }
  return events.map((event, index) => ({ ...event, id: index + 1, seq: index + 1, runId: 'run-1', sessionId: 'session-1', step: 0, ts: index + 1 })) as unknown as RunEvent[];
};

export const seqOfCheck = (events: readonly RunEvent[], command: string): number => {
  const found = events.filter((event) => event.type === 'verification.completed' && event.command === command).at(-1);
  if (found === undefined) throw new Error(`no check of ${command}`);
  return found.seq;
};
