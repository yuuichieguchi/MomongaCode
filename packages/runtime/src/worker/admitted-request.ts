import { tokenPriceOfQuote, usdOfNano } from '@momonga/protocol';
import type { BudgetExhausted, CompactRequest, CompactResource, CreateResponseBody, ModelQuote, RequestBudget, StreamEvent } from '@momonga/protocol';
import type { GatewayCallOptions, GatewayPort } from '../ports.ts';
import { admitStep, exhaustedText, requestBudgetOf, unpaidText } from './budget.ts';
import type { AdmittedStep, BudgetLedger, BudgetLimits, StepAdmission, StepSize } from './budget.ts';

export type BudgetAccount = {
  limits: BudgetLimits;
  quote(model: string): Promise<ModelQuote>;
  spend(): { unpricedCalls: number; costNano: number; reservedNano: number };
  ledger: BudgetLedger;
  release(): void;
  tail: Promise<void>;
};

export type AdmissionProof = RequestBudget | 'recorded';

export type CostCeiling = { max_cost_nano?: number; max_input_tokens?: number };

export type Refused = Exclude<StepAdmission, AdmittedStep>;

export class AdmissionRefusedError extends Error {
  readonly refused: Refused;

  constructor(refused: Refused) {
    super(refused.kind === 'lease_lost' ? 'the lease was lost before a model request was admitted' : 'the budget of the run does not pay for a model request');
    this.name = 'AdmissionRefusedError';
    this.refused = refused;
  }
}

export const quoteFor = async (account: BudgetAccount, model: string): Promise<ModelQuote | undefined> => (account.limits.maxCostNano === undefined ? undefined : account.quote(model));

export const admissionFor = (account: BudgetAccount, size: StepSize, quote: ModelQuote | undefined): StepAdmission => {
  const spend = account.spend();
  return admitStep({
    size,
    limits: account.limits,
    price: quote === undefined ? undefined : tokenPriceOfQuote(quote),
    unpricedCalls: spend.unpricedCalls,
    spentNano: spend.costNano,
    ledger: account.ledger,
  });
};

export const ceilingOf = (admitted: AdmittedStep): CostCeiling => (admitted.costLimited ? { max_cost_nano: admitted.reservedNano, max_input_tokens: admitted.inputUpper } : {});

export const overCeiling = (account: BudgetAccount): BudgetExhausted => {
  const limit = account.limits.maxCostNano;
  if (limit === undefined) throw new Error('the gateway refused a model request over a cost ceiling the run does not have');
  const spend = account.spend();
  return { dimension: 'cost', cause: 'cap_too_small', spent: spend.costNano + spend.reservedNano, limit };
};

const budgetFigure = (dimension: BudgetExhausted['dimension'], value: number): string => (dimension === 'cost' ? `${usdOfNano(value)} USD` : dimension === 'time' ? `${value} ms` : `${value} ${dimension}`);

export const exhaustedMessage = (exhausted: BudgetExhausted): string => exhaustedText(exhausted, budgetFigure);

export const unpaidMessage = (purpose: string, exhausted: BudgetExhausted): string => `the budget of the run does not pay for the ${purpose} call: ${unpaidText(exhausted, budgetFigure)}`;

export type Admitted = { admitted: AdmittedStep; proof: RequestBudget };

type Sent<T> = { kind: 'sent'; value: T } | Refused;

const admitAndSend = async <T>(account: BudgetAccount, ask: { model: string; size: StepSize }, send: (admitted: Admitted) => Promise<T>): Promise<Sent<T>> => {
  const quote = await quoteFor(account, ask.model);
  const admission = admissionFor(account, ask.size, quote);
  if (admission.kind !== 'admitted') return admission;
  try {
    return { kind: 'sent', value: await send({ admitted: admission, proof: requestBudgetOf(admission, quote) }) };
  } finally {
    account.release();
  }
};

export const withAdmission = <T>(account: BudgetAccount, ask: { model: string; size: StepSize }, send: (admitted: Admitted) => Promise<T>): Promise<Sent<T>> => {
  const result = account.tail.then(() => admitAndSend(account, ask, send));
  account.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const requireCeiling = (proof: AdmissionProof, ceiling: CostCeiling | undefined): void => {
  if (proof === 'recorded') return;
  if (ceiling?.max_cost_nano !== proof.reservedNano) throw new Error('a model request does not carry the cost ceiling of its admission');
};

export const streamAdmitted = (gateway: Pick<GatewayPort, 'stream'>, proof: AdmissionProof, body: CreateResponseBody, options: GatewayCallOptions): AsyncIterable<StreamEvent> => {
  requireCeiling(proof, body.momonga);
  return gateway.stream(body, options);
};

export const compactAdmitted = (gateway: Pick<GatewayPort, 'compact'>, proof: AdmissionProof, request: CompactRequest, options: GatewayCallOptions): Promise<CompactResource> => {
  requireCeiling(proof, request.momonga);
  return gateway.compact(request, options);
};
