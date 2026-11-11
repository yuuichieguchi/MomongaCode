import { RequestError } from '@agentclientprotocol/sdk';
import type { StopReason } from '@agentclientprotocol/sdk';
import { TARGET_NOT_READY } from '@momonga/protocol';
import type { BudgetExhausted } from '@momonga/protocol';
import { stoppedByLine } from '../commands/report.ts';
import { unmetConditionLines } from '../policy-messages.ts';
import type { RunView } from '../client/views.ts';

export const RUN_STOPPED_CODE = -32010;

export const BUDGET_EXHAUSTED_CODE = 'budget_exhausted';

const storedRemedyOf = (message: string): { remedy?: string } => {
  const lines = message.split('\n');
  const remedy = lines.length > 1 ? lines.at(-1) : undefined;
  return remedy === undefined ? {} : { remedy };
};

const detailOf = (run: RunView) => ({
  runId: run.id,
  status: run.status,
  ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
  ...(run.report === undefined ? {} : { report: run.report }),
  ...(run.error === undefined ? {} : { error: run.error }),
  ...(run.error?.code === TARGET_NOT_READY ? { code: TARGET_NOT_READY, ...storedRemedyOf(run.error.message) } : {}),
});

const stopped = (run: RunView, description: string): RequestError => new RequestError(RUN_STOPPED_CODE, `run ${run.id} ${description}`, detailOf(run));

const failed = (run: RunView, description: string): RequestError => RequestError.internalError(detailOf(run), `run ${run.id} ${description}`);

type RunStopReason = NonNullable<RunView['stopReason']>;

type Ending = StopReason | 'failure';

const NO_DIMENSION_ENDING: StopReason = 'max_tokens';

const BUDGET_ENDINGS: Readonly<Record<BudgetExhausted['dimension'], Ending>> = {
  steps: 'max_turn_requests',
  tokens: 'max_tokens',
  cost: 'failure',
  time: 'failure',
  retries: 'failure',
};

const STOP_ENDINGS: Readonly<Record<Exclude<RunStopReason, 'budget'>, Ending>> = {
  max_steps: 'max_turn_requests',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  timeout: 'failure',
  loop: 'failure',
  approval_timeout: 'failure',
  usage_limit: 'failure',
  conditions_unmet: 'failure',
};

const stoppedText = (run: RunView, reason: Exclude<RunStopReason, 'budget'>): string =>
  reason === 'conditions_unmet' && run.report !== undefined ? ['stopped: conditions_unmet', ...unmetConditionLines(run.report)].join('\n') : `stopped: ${reason}`;

const budgetEndingOf = (run: RunView): StopReason => {
  const exhausted = run.report?.stoppedBy;
  if (exhausted === undefined) return NO_DIMENSION_ENDING;
  const ending = BUDGET_ENDINGS[exhausted.dimension];
  if (ending !== 'failure') return ending;
  throw new RequestError(RUN_STOPPED_CODE, `run ${run.id} ${stoppedByLine(exhausted)}`, { ...detailOf(run), code: BUDGET_EXHAUSTED_CODE, budget: exhausted });
};

const stoppedReasonOf = (run: RunView): StopReason => {
  const reason = run.stopReason;
  if (reason === undefined) throw new Error(`run ${run.id} is STOPPED without a stop reason`);
  if (reason === 'budget') return budgetEndingOf(run);
  const ending = STOP_ENDINGS[reason];
  if (ending !== 'failure') return ending;
  throw stopped(run, stoppedText(run, reason));
};

export const stopReasonOf = (run: RunView): StopReason => {
  switch (run.status) {
    case 'COMPLETED':
      return 'end_turn';
    case 'CANCELLED':
      return 'cancelled';
    case 'STOPPED':
      return stoppedReasonOf(run);
    case 'FAILED':
      throw failed(run, `failed${run.error === undefined ? '' : `: ${run.error.code}: ${run.error.message}`}`);
    case 'QUEUED':
    case 'RUNNING':
    case 'WAITING_TOOL':
    case 'WAITING_HUMAN':
    case 'CANCELLING':
      throw new Error(`run ${run.id} is ${run.status}, which is not a terminal status`);
  }
};
