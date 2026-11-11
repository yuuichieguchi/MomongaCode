import type { ProofArith, ProofBool } from './arith.ts';

export type ProofResult =
  | { readonly status: 'proved' }
  | { readonly status: 'refuted'; readonly model: Readonly<Record<string, string>> };

export class ProofUnknownError extends Error {
  constructor(name: string, reason: string) {
    super(`the solver could not decide the proof ${name}: ${reason}`);
    this.name = 'ProofUnknownError';
  }
}

export class ProofNotRefutedError extends Error {
  constructor(name: string) {
    super(`the evidence proof ${name} was expected to be refuted but is proved`);
    this.name = 'ProofNotRefutedError';
  }
}

export const prove = async (arith: ProofArith, goal: ProofBool): Promise<ProofResult> => {
  const { ctx } = arith;
  const solver = new ctx.Solver();
  solver.add(...arith.assertions(), ctx.Not(goal));
  const status = await solver.check();
  if (status === 'unsat') return { status: 'proved' };
  if (status === 'unknown') throw new ProofUnknownError(arith.name, solver.reasonUnknown());
  const model = solver.model();
  const values = Object.fromEntries([...arith.variables()].map(([variable, term]) => [variable, model.eval(term, true).toString()]));
  return { status: 'refuted', model: values };
};

export const expectRefuted = async (arith: ProofArith, goal: ProofBool): Promise<Readonly<Record<string, string>>> => {
  const result = await prove(arith, goal);
  if (result.status === 'proved') throw new ProofNotRefutedError(arith.name);
  return result.model;
};
