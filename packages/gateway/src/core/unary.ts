import { uuidv7 } from '@momonga/foundation';
import type {
  CompactResource,
  CompactionItem,
  CountTokensResult,
  InputItem,
} from '@momonga/protocol';
import { parseDeadlineHeader, withDeadline } from './deadline.ts';
import { errorBoundFor, estimateInputTokens } from './estimate.ts';
import { invalidRequest } from './errors.ts';
import { normalizeInput, resolveInput } from './input.ts';
import { failureFrom, runWithRetry } from './retry.ts';
import type { RetryOutcome } from './retry.ts';
import type { TargetRuntime } from './router.ts';
import type { Services } from './services.ts';
import type { RequestValidator } from './validation.ts';

export type UnaryService = {
  countTokens(rawBody: unknown, signal: AbortSignal, deadlineHeader: string | undefined): Promise<CountTokensResult>;
  compact(rawBody: unknown, signal: AbortSignal, deadlineHeader: string | undefined): Promise<CompactResource>;
};

const identifier = (services: Services, prefix: string): string => `${prefix}_${uuidv7(services.clock).replaceAll('-', '')}`;

const callTargets = <T>(
  services: Services,
  candidates: readonly TargetRuntime[],
  signal: AbortSignal,
  deadlineAt: number | undefined,
  call: (target: TargetRuntime, attemptNumber: number, signal: AbortSignal) => Promise<T>,
): Promise<RetryOutcome<T>> =>
  withDeadline(services, deadlineAt, signal, (guarded) =>
    runWithRetry({
      candidates,
      policy: { ...services.config.retry, random: services.random, clock: services.clock, timers: services.timers },
      signal: guarded,
      deadlineAt,
      attempt: async (target, attemptNumber) => {
        const release = await target.gate.acquire(guarded);
        try {
          return await call(target, attemptNumber, guarded);
        } catch (error) {
          throw failureFrom(target.adapter, error, guarded);
        } finally {
          release();
        }
      },
    }),
  );

export const createUnaryService = (services: Services, validator: RequestValidator): UnaryService => ({
  countTokens: async (rawBody, signal, deadlineHeader) => {
    const request = validator.parseCountTokens(rawBody);
    const deadlineAt = parseDeadlineHeader(deadlineHeader, services.clock.now());
    const target = services.router.targetsOf(request.model)[0];
    if (target === undefined) throw new Error(`model alias "${request.model}" has no targets`);
    const resolved = resolveInput(services.store, services.codec, undefined, normalizeInput(request.input));
    const countable: InputItem[] = resolved.forAdapter.map((item) =>
      item.type === 'compaction_summary'
        ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: item.summary }] }
        : item,
    );
    const countTokens = target.adapter.countTokens;
    if (countTokens === undefined) {
      const inputTokens = estimateInputTokens({ input: resolved.forAdapter, instructions: request.instructions });
      return { input_tokens: inputTokens, method: 'estimated', error_bound: errorBoundFor(inputTokens) };
    }
    const outcome = await callTargets(services, [target], signal, deadlineAt, (chosen, attemptNumber, guarded) =>
      countTokens.call(
        chosen.adapter,
        {
          model: chosen.model,
          input: countable,
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        },
        { signal: guarded, target: { name: chosen.name, model: chosen.model }, attempt: attemptNumber },
      ),
    );
    outcome.target.breaker.onSuccess();
    return outcome.value;
  },
  compact: async (rawBody, signal, deadlineHeader) => {
    const request = validator.parseCompact(rawBody);
    const deadlineAt = parseDeadlineHeader(deadlineHeader, services.clock.now());
    const targets = services.router.targetsOf(request.model);
    const resolved = resolveInput(services.store, services.codec, request.previous_response_id, normalizeInput(request.input));
    const candidates = targets.filter((target) => target.adapter.compact !== undefined);
    if (candidates.length === 0) {
      throw invalidRequest('capability_unsupported', `no target of model alias "${request.model}" supports compaction`, 'model');
    }
    const outcome = await callTargets(services, candidates, signal, deadlineAt, (target, attemptNumber, guarded) => {
      const compact = target.adapter.compact;
      if (compact === undefined) throw new TypeError(`target "${target.name}" lost its compact capability`);
      return compact.call(
        target.adapter,
        {
          model: target.model,
          input: resolved.forAdapter,
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        },
        { signal: guarded, target: { name: target.name, model: target.model }, attempt: attemptNumber },
      );
    });
    outcome.target.breaker.onSuccess();
    const item: CompactionItem = {
      type: 'compaction',
      id: identifier(services, 'cmp'),
      encrypted_content: services.codec.encode(outcome.value.summary),
    };
    return {
      id: identifier(services, 'resp'),
      object: 'response.compaction',
      output: [item],
      created_at: Math.floor(services.clock.now() / 1000),
      usage: outcome.value.usage,
    };
  },
});
