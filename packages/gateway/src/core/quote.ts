import { quoteChain } from '@momonga/observability';
import type { PriceTable } from '@momonga/observability';
import { BUDGET_EXCEEDED_CODE, MOMONGA_REQUEST_FIELDS, fitsCostCeiling, outputTokensFor, tokenPriceOfQuote } from '@momonga/protocol';
import type { Capabilities, ModelQuote, ReasoningEffort } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';
import type { Router, TargetRuntime } from './router.ts';

type Priced = Pick<TargetRuntime, 'billing' | 'provider' | 'model'>;

const quoteOfMembers = (model: string, members: readonly Priced[], table: PriceTable | undefined, atMs: number): ModelQuote => quoteChain(model, members, table ?? [], atMs);

export const quoteOf = (router: Pick<Router, 'chainOf' | 'resolveRequestModel'>, requested: string, table: PriceTable | undefined, atMs: number): ModelQuote => {
  const model = router.resolveRequestModel(requested, true);
  return quoteOfMembers(model, router.chainOf(model), table, atMs);
};

const refusal = (message: string): Error => invalidRequest(BUDGET_EXCEEDED_CODE, message, MOMONGA_REQUEST_FIELDS.maxCostNano);

export type OutputBoundCapabilities = Pick<Capabilities, 'maxOutputTokens' | 'reasoning' | 'outputBoundField'>;

export const pricedOutputBoundOf = (capabilities: OutputBoundCapabilities, effort: ReasoningEffort | undefined, visible: number | undefined): number =>
  capabilities.outputBoundField === 'none' ? capabilities.maxOutputTokens : outputTokensFor(capabilities, effort, visible);

export type CostBounds = {
  ceilingNano: number | undefined;
  inputBound: number | undefined;
  visible: number | undefined;
  effort: ReasoningEffort | undefined;
  smallestAnswer: number;
};

const largestFitting = (smallest: number, largest: number, fits: (visible: number) => boolean): number | undefined => {
  if (largest < smallest || !fits(smallest)) return undefined;
  let low = smallest;
  let high = largest;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
};

export function outputBoundWithinCostCeiling(bounds: CostBounds & { visible: number }, target: Priced & Pick<TargetRuntime, 'display'>, capabilities: OutputBoundCapabilities, table: PriceTable | undefined, atMs: number): number;
export function outputBoundWithinCostCeiling(bounds: CostBounds, target: Priced & Pick<TargetRuntime, 'display'>, capabilities: OutputBoundCapabilities, table: PriceTable | undefined, atMs: number): number | undefined;
export function outputBoundWithinCostCeiling(bounds: CostBounds, target: Priced & Pick<TargetRuntime, 'display'>, capabilities: OutputBoundCapabilities, table: PriceTable | undefined, atMs: number): number | undefined {
  const { ceilingNano, inputBound, visible, effort } = bounds;
  if (ceilingNano === undefined) return visible;
  if (inputBound === undefined) throw new Error('a request with a cost ceiling reached a model without its input bound');
  const price = tokenPriceOfQuote(quoteOfMembers(target.display, [target], table, atMs));
  if (price === undefined) throw refusal(`The request may cost at most ${ceilingNano} nano-USD, and ${target.display} has no price, so its cost cannot be bounded.`);
  const fits = (candidate: number | undefined): boolean => fitsCostCeiling(inputBound, pricedOutputBoundOf(capabilities, effort, candidate), price, ceilingNano);
  if (fits(visible)) return visible;
  const capped = capabilities.outputBoundField === 'none' ? undefined : largestFitting(bounds.smallestAnswer, visible ?? capabilities.maxOutputTokens, fits);
  if (capped !== undefined) return capped;
  throw refusal(
    `The request may cost at most ${ceilingNano} nano-USD, and ${inputBound} input tokens with the smallest answer of ${pricedOutputBoundOf(capabilities, effort, bounds.smallestAnswer)} output tokens on ${target.display} can cost more at its current price.`,
  );
}
