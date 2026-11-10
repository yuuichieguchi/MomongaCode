import { RequestError } from '@agentclientprotocol/sdk';
import type { StopReason } from '@agentclientprotocol/sdk';
import { TARGET_NOT_READY } from '@momonga/protocol';
import type { RunView } from '../client/views.ts';

export const RUN_STOPPED_CODE = -32010;

const storedRemedyOf = (message: string): { remedy?: string } => {
  const lines = message.split('\n');
  const remedy = lines.length > 1 ? lines.at(-1) : undefined;
  return remedy === undefined ? {} : { remedy };
};

const detailOf = (run: RunView) => ({
  runId: run.id,
  status: run.status,
  ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
  ...(run.error === undefined ? {} : { error: run.error }),
  ...(run.error?.code === TARGET_NOT_READY ? { code: TARGET_NOT_READY, ...storedRemedyOf(run.error.message) } : {}),
});

const stopped = (run: RunView, description: string): RequestError => new RequestError(RUN_STOPPED_CODE, `run ${run.id} ${description}`, detailOf(run));

const failed = (run: RunView, description: string): RequestError => RequestError.internalError(detailOf(run), `run ${run.id} ${description}`);

const stoppedReasonOf = (run: RunView): StopReason => {
  const reason = run.stopReason;
  if (reason === undefined) throw new Error(`run ${run.id} is STOPPED without a stop reason`);
  switch (reason) {
    case 'max_steps':
      return 'max_turn_requests';
    case 'max_tokens':
    case 'budget':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'timeout':
    case 'loop':
    case 'approval_timeout':
    case 'usage_limit':
      throw stopped(run, `stopped: ${reason}`);
  }
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
