import type { PermissionMode, PinnedCompletion, PinnedMandate, RunEvent, RunEventPayload, RunStatus, SideEffect } from '@momonga/protocol';
import type { RunInfo } from '@momonga/reliability';

export const T0 = 1_800_000_000_000;
export const SESSION_ID = 'sess-1';

export type Timed = readonly [number, RunEventPayload];

export const eventsOf = (runId: string, timed: readonly Timed[]): RunEvent[] =>
  timed.map(
    ([createdAt, payload], index) =>
      ({ ...payload, id: index + 1, runId, sessionId: SESSION_ID, seq: index + 1, step: 0, leaseToken: 1, createdAt }) as RunEvent,
  );

export const COMPLETION: PinnedCompletion = { conditions: [{ id: 'tests', command: 'npm test', when: 'always', source: 'request' }], requirements: [] };

export const SCOPED_MANDATE: PinnedMandate = { completion: { conditions: [], requirements: [] }, scope: { allow: ['Read'], ask: ['GitPush'], deny: [] } };

const mandatePinOf = (options: { declared?: boolean; mandate?: PinnedMandate }): { mandate?: PinnedMandate } => {
  if (options.mandate !== undefined) return { mandate: options.mandate };
  return options.declared === true ? { mandate: { completion: COMPLETION } } : {};
};

export const started = (
  attempt: number,
  options: { declared?: boolean; mandate?: PinnedMandate; model?: string; mode?: PermissionMode; now?: number } = {},
): RunEventPayload =>
  ({
    type: 'run.started',
    attempt,
    now: options.now ?? T0,
    pins: { model: options.model ?? 'fm', ...mandatePinOf(options) },
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  }) as RunEventPayload;

export const status = (from: RunStatus, to: RunStatus): RunEventPayload => ({ type: 'run.status', from, to });

export const attemptFailed = (attempt: number, code: string): RunEventPayload => ({ type: 'attempt.failed', attempt, code }) as unknown as RunEventPayload;

export const attemptLost = (lastLiveAt: number): RunEventPayload => ({ type: 'attempt.lost', lastLiveAt }) as unknown as RunEventPayload;

export const toolCall = (callId: string, sideEffect: SideEffect): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: `p-${callId}`,
  name: sideEffect === 'read_only' ? 'Read' : 'Bash',
  kind: sideEffect === 'read_only' ? 'read' : 'execute',
  sideEffect,
  title: callId,
  rawInput: {},
});

export const toolStarted = (callId: string): RunEventPayload => ({ type: 'tool.started', callId, idemKey: `idem-${callId}` });

export const toolCompleted = (callId: string): RunEventPayload => ({ type: 'tool.completed', callId, status: 'completed', output: 'ok' });

export const reconciled = (callId: string, outcome: 'already_applied' | 'not_applied' | 'unknown'): RunEventPayload => ({
  type: 'tool.reconciled',
  callId,
  outcome,
  output: outcome,
});

export const modelRequested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: 'd'.repeat(64), body: {} });

export const modelResponded = (step: number): RunEventPayload =>
  ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) as unknown as RunEventPayload;

export const permissionRequested = (callId: string): RunEventPayload => ({
  type: 'tool.permission.requested',
  approvalId: `a-${callId}`,
  callId,
  options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
  subjectDigest: 's'.repeat(64),
  reason: 'ask',
  shown: { title: 'approval', input: {} },
});

export const unknownEffectRequested = (callId: string): RunEventPayload => ({
  type: 'tool.unknown.requested',
  approvalId: `u-${callId}`,
  callIds: [callId],
  options: [{ optionId: 'allow_once', name: 'Continue', kind: 'allow_once' }],
  subjectDigest: 's'.repeat(64),
});

export const permissionClassifiedAllow = (callId: string): RunEventPayload => ({
  type: 'tool.permission.classified',
  callId,
  subjectDigest: 's'.repeat(64),
  outcome: 'allow',
});

export const elicitationRequested = (callId: string): RunEventPayload => ({
  type: 'tool.elicitation.requested',
  inputId: `i-${callId}`,
  callId,
  server: 'srv',
  requests: [],
});

export const authorizationRequired = (): RunEventPayload => ({ type: 'mcp.authorization.required', server: 'srv' });

export const messageDelta = (text: string): RunEventPayload => ({ type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'm1', text });

export const thoughtDelta = (text: string): RunEventPayload => ({ type: 'agent.thought.delta', step: 1, attempt: 1, itemId: 't1', text });

export const runInfo = (
  overrides: Partial<RunInfo> & { runId: string },
): RunInfo => ({
  rootRunId: overrides.runId,
  sessionId: SESSION_ID,
  status: 'COMPLETED',
  createdAt: T0,
  limits: {},
  step: 1,
  tokensTotal: 100,
  costNano: 0,
  model: 'fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  ...overrides,
});

export const terminal = (to: RunStatus): RunEventPayload => status('RUNNING', to);
