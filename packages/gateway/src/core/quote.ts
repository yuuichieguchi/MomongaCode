import { quoteChain } from '@momonga/observability';
import type { PriceTable } from '@momonga/observability';
import { BUDGET_EXCEEDED_CODE, MOMONGA_REQUEST_FIELDS, fitsCostCeiling, tokenPriceOfQuote } from '@momonga/protocol';
import type { CreateResponseBody, ModelQuote } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';
import type { Router, TargetRuntime } from './router.ts';

type Priced = Pick<TargetRuntime, 'billing' | 'provider' | 'model'>;

const quoteOfMembers = (model: string, members: readonly Priced[], table: PriceTable | undefined, atMs: number): ModelQuote => quoteChain(model, members, table ?? [], atMs);

export const quoteOf = (router: Pick<Router, 'chainOf' | 'resolveRequestModel'>, requested: string, table: PriceTable | undefined, atMs: number): ModelQuote => {
  const model = router.resolveRequestModel(requested, true);
  return quoteOfMembers(model, router.chainOf(model), table, atMs);
};

const refusal = (message: string): Error => invalidRequest(BUDGET_EXCEEDED_CODE, message, MOMONGA_REQUEST_FIELDS.maxCostNano);

export const requireWithinCostCeiling = (body: CreateResponseBody, target: Priced & Pick<TargetRuntime, 'display'>, table: PriceTable | undefined, atMs: number): void => {
  const ceilingNano = body.momonga?.max_cost_nano;
  const inputBound = body.momonga?.max_input_tokens;
  const outputBound = body.max_output_tokens;
  if (ceilingNano === undefined) return;
  if (inputBound === undefined || outputBound === undefined || outputBound === null) throw new Error('a request with a cost ceiling reached a model without its input and output bounds');
  const price = tokenPriceOfQuote(quoteOfMembers(target.display, [target], table, atMs));
  if (price === undefined) throw refusal(`The request may cost at most ${ceilingNano} nano-USD, and ${target.display} has no price, so its cost cannot be bounded.`);
  if (!fitsCostCeiling(inputBound, outputBound, price, ceilingNano)) {
    throw refusal(`The request may cost at most ${ceilingNano} nano-USD, and ${inputBound} input tokens with ${outputBound} output tokens on ${target.display} can cost more at its current price.`);
  }
};
