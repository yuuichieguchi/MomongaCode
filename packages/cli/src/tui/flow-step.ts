import { AsyncLocalStorage } from 'node:async_hooks';
import type { PickChoice, PickRequest } from './picker.tsx';

export class Abandoned extends Error {
  constructor() {
    super('the person left this step');
    this.name = 'Abandoned';
  }
}

export const isAbandoned = (error: unknown): error is Abandoned => error instanceof Abandoned;

export type FlowStep = { readonly signal: AbortSignal; abandon(): void };

export type FlowScope = { readonly id: number; readonly raised: string | undefined; readonly steps: FlowStep[] };

const scopes = new AsyncLocalStorage<FlowScope>();

const steps = new AsyncLocalStorage<FlowStep>();

export const currentScope = (): FlowScope | undefined => scopes.getStore();

export const currentStep = (): FlowStep | undefined => steps.getStore();

export const inScope = <T>(scope: FlowScope, work: () => Promise<T>): Promise<T> => scopes.run(scope, work);

export const untilAborted = <T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> => {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const leave = (): void => reject(signal.reason);
    if (signal.aborted) {
      void work.then(() => undefined, () => undefined);
      leave();
      return;
    }
    signal.addEventListener('abort', leave, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', leave);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', leave);
        reject(error);
      },
    );
  });
};

export const untilAbandoned = <T>(step: FlowStep | undefined, work: Promise<T>): Promise<T> => untilAborted(step?.signal, work);

const startStep = (parent: FlowStep | undefined): { readonly step: FlowStep; dispose(): void } => {
  const controller = new AbortController();
  const abandon = (): void => controller.abort(new Abandoned());
  if (parent !== undefined) {
    if (parent.signal.aborted) abandon();
    else parent.signal.addEventListener('abort', abandon, { once: true });
  }
  return {
    step: { signal: controller.signal, abandon },
    dispose: () => {
      parent?.signal.removeEventListener('abort', abandon);
    },
  };
};

export const runInStep = async <T>(work: () => Promise<T>): Promise<T> => {
  const parent = currentStep();
  const { step: started, dispose } = startStep(parent);
  const scope = currentScope();
  scope?.steps.push(started);
  try {
    return await untilAbandoned(started, steps.run(started, work));
  } finally {
    dispose();
    if (scope !== undefined) {
      const index = scope.steps.indexOf(started);
      if (index >= 0) scope.steps.splice(index, 1);
    }
  }
};

export type ChoosePort = (request: PickRequest) => Promise<PickChoice | undefined>;

export type ListSource = () => PickRequest | Promise<PickRequest>;

export type Chosen<R> = { readonly value: R } | undefined;

export const answerThen = async <A, R>(ask: (left: A | undefined) => Promise<A | undefined>, step: (answer: A) => Promise<R>): Promise<Chosen<R>> => {
  let left: A | undefined;
  for (;;) {
    const answer = await ask(left);
    if (answer === undefined) return undefined;
    const parent = currentStep();
    const { step: started, dispose } = startStep(parent);
    const scope = currentScope();
    scope?.steps.push(started);
    try {
      return { value: await untilAbandoned(started, steps.run(started, () => step(answer))) };
    } catch (error) {
      if (!started.signal.aborted || parent?.signal.aborted === true) throw error;
      left = answer;
    } finally {
      dispose();
      if (scope !== undefined) {
        const index = scope.steps.indexOf(started);
        if (index >= 0) scope.steps.splice(index, 1);
      }
    }
  }
};

export const chooseThen = <R>(choose: ChoosePort, source: ListSource, step: (choice: PickChoice) => Promise<R>): Promise<Chosen<R>> =>
  answerThen<PickChoice, R>(async (left) => {
    const request = await source();
    return choose(left === undefined ? request : { ...request, initial: left.index });
  }, step);

export type PickPort = (request: PickRequest) => Promise<number | undefined>;

export const pickThen = <R>(pick: PickPort, source: ListSource, step: (index: number) => Promise<R>): Promise<Chosen<R>> =>
  chooseThen(
    async (request) => {
      const index = await pick(request);
      return index === undefined ? undefined : { index, alt: false };
    },
    source,
    (choice) => step(choice.index),
  );
