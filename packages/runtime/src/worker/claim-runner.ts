import { createTokenMeter } from '@momonga/context';
import { computeBackoff, sha256Hex } from '@momonga/foundation';
import type { Claim } from '@momonga/store';
import type { ClaimContext, Flow, Terminals } from './claim-context.ts';
import { reconcileStartedCalls } from './cancel-recovery.ts';
import { startClaimControl } from './claim-control.ts';
import { describeError, LeaseLostError } from './errors.ts';
import { inlineOutputLimitFor } from './inline-limit.ts';
import { openJournal } from './journal.ts';
import type { Journal } from './journal.ts';
import { readRunLimits } from './limits.ts';
import { decideAfterResponse, responsePending, resumeInFlight, runModelStep } from './model-step.ts';
import { readPins } from './pins.ts';
import type { RunPins } from './pins.ts';
import { createTerminals } from './terminals.ts';
import { settleCalls } from './tool-step.ts';
import type { WorkerOptions } from './types.ts';
import type { TraceSpan } from '../ports.ts';
import { buildSystemPrompt } from '../system-prompt.ts';

const DEFAULT_HEARTBEAT_DIVISOR = 3;
const DEFAULT_CANCEL_POLL_MS = 250;
const REQUEUE_BASE_MS = 1000;
const REQUEUE_MAX_MS = 60_000;
const TOOLS_CHANGED_NOTICE = 'The available tools changed since this run started; the run continues with the current tool set.';

export const runClaim = async (options: WorkerOptions, claim: Claim): Promise<void> => {
  const { store, tracer } = options;
  const control = startClaimControl({
    store,
    claim,
    heartbeatMs: options.heartbeatMs ?? options.leaseMs / DEFAULT_HEARTBEAT_DIVISOR,
    cancelPollMs: options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
  });
  let journal: Journal | undefined;
  let terminals: Terminals | undefined;
  let agentSpan: TraceSpan | undefined;
  try {
    journal = openJournal({ store, claim, lost: control.lost });
    terminals = createTerminals({ store, claim, journal, control });
    agentSpan = tracer.startAgentSpan({ runId: claim.runId, sessionId: claim.sessionId, attempt: claim.attempt });
    await drive(options, claim, journal, control, terminals, agentSpan);
    agentSpan.end();
  } catch (error) {
    const cause = control.failure() ?? error;
    agentSpan?.end(cause);
    if (control.leaseLost() || cause instanceof LeaseLostError) return;
    if (journal === undefined || terminals === undefined) throw cause;
    try {
      if (control.cancelRequested() && control.failure() === undefined) {
        if (!control.raisedDuringCancel(cause)) {
          journal.append([{ type: 'notice', level: 'error', message: `The run was cancelled after an error: ${describeError(cause)}` }]);
        }
        terminals.cancel();
        return;
      }
      journal.append([{ type: 'notice', level: 'error', message: `The attempt failed and will be retried: ${describeError(cause)}` }]);
      const delay = computeBackoff({ attempt: claim.attempt - 1, baseMs: REQUEUE_BASE_MS, maxMs: REQUEUE_MAX_MS, random: Math.random });
      terminals.yieldTo('QUEUED', options.clock.now() + delay);
    } catch (recoveryError) {
      if (!(recoveryError instanceof LeaseLostError)) throw recoveryError;
    }
  } finally {
    control.stop();
  }
};

const drive = async (
  options: WorkerOptions,
  claim: Claim,
  journal: Journal,
  control: ClaimContext['control'],
  terminals: ClaimContext['terminals'],
  agentSpan: ClaimContext['agentSpan'],
): Promise<void> => {
  const { store, gateway, tools, clock } = options;
  const run = store.getRun(claim.runId);
  if (run === undefined) throw new Error(`unknown run ${claim.runId}`);
  const session = store.getSession(run.sessionId);
  if (session === undefined) throw new Error(`unknown session ${run.sessionId}`);
  if (claim.status === 'CANCELLING' || run.cancelRequested) {
    await reconcileStartedCalls({ options, run, session, journal, control });
    terminals.cancel();
    return;
  }

  const systemPrompt = (options.systemPrompt ?? buildSystemPrompt)({ cwd: session.cwd, platform: process.platform });
  const systemPromptDigest = sha256Hex(systemPrompt);
  const toolSet = await tools.toolSet(run.id);
  const recorded = journal.state.pins;
  const pins: RunPins =
    recorded === undefined
      ? {
          modelAlias: session.modelAlias,
          systemPromptDigest,
          toolSetDigest: toolSet.digest,
          capabilities: await gateway.capabilities(session.modelAlias),
        }
      : readPins(recorded);
  journal.append([{ type: 'run.started', attempt: claim.attempt, now: clock.now(), pins: { ...pins } }]);

  if (recorded !== undefined) {
    if (pins.modelAlias !== session.modelAlias || pins.systemPromptDigest !== systemPromptDigest) {
      const drift = pins.modelAlias !== session.modelAlias ? 'the model alias' : 'the system prompt';
      terminals.finish('FAILED', {
        error: { code: 'pins_mismatch', message: `${drift} changed since this run started, so it cannot be resumed` },
      });
      return;
    }
    if (pins.toolSetDigest !== toolSet.digest && !journal.state.notes.some((note) => note.message === TOOLS_CHANGED_NOTICE)) {
      journal.append([{ type: 'notice', level: 'warning', message: TOOLS_CHANGED_NOTICE }]);
    }
  }

  const limits = readRunLimits(run.limits, options.defaults);
  const rules = await options.settings.rules(session);
  const ctx: ClaimContext = {
    options,
    claim,
    run,
    alias: pins.modelAlias,
    capabilities: pins.capabilities,
    limits,
    toolSet,
    functionTools: toolSet.forModel({ mode: session.permissionMode, rules }),
    systemPrompt,
    inlineLimit: inlineOutputLimitFor(pins.capabilities),
    journal,
    control,
    terminals,
    agentSpan,
    meter: createTokenMeter({ counter: { count: (request) => control.recordingRaised(gateway.countTokens(request, { signal: control.signal })) }, model: pins.modelAlias, capabilities: pins.capabilities }),
    pinnedDigest: { value: undefined },
  };

  if (responsePending(journal.state)) {
    if ((await decideAfterResponse(ctx)) === 'done') return;
  } else if ((await settleCalls(ctx)) === 'done') {
    return;
  }
  if ((await resumeInFlight(ctx)) === 'done') return;
  for (let flow: Flow = 'continue'; flow === 'continue'; ) {
    if (control.cancelRequested()) {
      terminals.cancel();
      return;
    }
    flow = await runModelStep(ctx);
  }
};
