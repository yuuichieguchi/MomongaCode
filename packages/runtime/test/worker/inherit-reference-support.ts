import type { RunEventPayload } from '@momonga/protocol';
import { knownValue } from '@momonga/store';
import type { Run, RuntimeStore } from '@momonga/store';
import { chainBuilder, oracleProjection } from '../../../store/test/support/reference.ts';
import type { InheritPlanReply, InheritedWindowReply, PlanRequest, ReferenceFacts, ReferenceHarness, WindowRequest } from '../../../store/test/support/reference.ts';
import type { Env } from './harness.ts';

export type FactsTrace = { plans: PlanRequest[]; windows: WindowRequest[]; windowReplies: InheritedWindowReply[]; planReplies: InheritPlanReply[] };

export const newFactsTrace = (): FactsTrace => ({ plans: [], windows: [], windowReplies: [], planReplies: [] });

export const referenceFactsOf = (store: RuntimeStore): ReferenceFacts => {
  const facts = store.journalFacts as unknown as Partial<ReferenceFacts>;
  if (typeof facts.inheritedWindow !== 'function') throw new Error('journalFacts has no inheritedWindow');
  if (typeof facts.inheritPlan !== 'function') throw new Error('journalFacts has no inheritPlan');
  return facts as ReferenceFacts;
};

export type FactsOverride = {
  plan?: (request: PlanRequest, call: number) => Promise<InheritPlanReply> | undefined;
  window?: (request: WindowRequest, call: number) => Promise<InheritedWindowReply> | undefined;
};

export const tracedStore = (store: RuntimeStore, trace: FactsTrace, override: FactsOverride = {}): RuntimeStore => {
  const facts = referenceFactsOf(store);
  const traced: ReferenceFacts = {
    inheritPlan: async (request, signal) => {
      trace.plans.push(request);
      const replaced = override.plan?.(request, trace.plans.length);
      const reply = await (replaced ?? facts.inheritPlan(request, signal));
      trace.planReplies.push(reply);
      return reply;
    },
    inheritedWindow: async (request, signal) => {
      trace.windows.push(request);
      const replaced = override.window?.(request, trace.windows.length);
      const reply = await (replaced ?? facts.inheritedWindow(request, signal));
      trace.windowReplies.push(reply);
      return reply;
    },
  };
  const journalFacts = { ...store.journalFacts, ...traced } as unknown as RuntimeStore['journalFacts'];
  return new Proxy(store, { get: (target, key, receiver) => (key === 'journalFacts' ? journalFacts : Reflect.get(target, key, receiver)) });
};

export const harnessOf = (env: Env): ReferenceHarness => ({
  dir: env.root,
  dbPath: env.dbPath,
  clock: env.clock,
  store: env.store,
  calls: { plan: 0, window: 0 },
  sessionId: env.session.id,
});

export const builderOf = (env: Env) => chainBuilder(harnessOf(env));

export const plantOldShapeChild = (env: Env, input: string): Run => {
  const b = builderOf(env);
  const child = b.createRun(input);
  const payload = oracleProjection(env.store, child, knownValue(env.store.getSession(env.session.id)?.permissionMode ?? 'default', `the permission mode of session ${env.session.id}`));
  env.seed(child.id, [payload as unknown as RunEventPayload], 'release');
  return env.run(child.id);
};
