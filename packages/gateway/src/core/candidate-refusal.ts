import type { GatewayError } from './errors.ts';
import { invalidRequest } from './errors.ts';

export const REFUSAL_STAGES = { tools: 0, images: 1, sampling: 2, summaryCap: 3, inputSize: 4 } as const;

export type Refusal = { stage: number; error: GatewayError };

export class CandidateRefused extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.error.message);
    this.name = 'CandidateRefused';
    this.refusal = refusal;
  }
}

export const refusalErrorOf = (refusals: readonly Refusal[]): GatewayError => {
  const last = Math.max(...refusals.map((refusal) => refusal.stage));
  const atLast = refusals.filter((refusal) => refusal.stage === last);
  const [first] = atLast;
  if (first === undefined) throw new Error('refusalErrorOf needs at least one refusal');
  if (last !== REFUSAL_STAGES.sampling) return first.error;
  return invalidRequest('sampling_not_accepted', atLast.map((refusal) => refusal.error.message).join('; '), first.error.body.param);
};
