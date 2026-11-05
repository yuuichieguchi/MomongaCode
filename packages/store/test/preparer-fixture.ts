import type { RunEventPayload } from '@momonga/protocol';
import type { ContributionMeasured, ContributionPayload, ContributionPreparer, ContributionRequest, RuntimeStore } from '@momonga/store';

import { noJournalFacts } from './helpers.ts';

export type Reply = { kind: 'fresh'; id: string } | { kind: 'stale'; id: string } | { kind: 'fail'; error: Error } | { kind: 'nothing' };

export type SeenRequest = { runId: string; leading: RunEventPayload[] };

export type FakePreparer = {
  preparer: ContributionPreparer;
  requests: SeenRequest[];
  bind(store: RuntimeStore): void;
  during(action: (request: SeenRequest, call: number) => void): void;
};

export const contributionOf = (id: string): ContributionPayload => ({ type: 'context.contribution', items: [{ kind: 'memory', id, contributed: true }] });

export const fakePreparer = (replies: Reply[] = [], fallback: Reply = { kind: 'fresh', id: 'm1' }): FakePreparer => {
  const requests: SeenRequest[] = [];
  let bound: RuntimeStore | undefined;
  let action: ((request: SeenRequest, call: number) => void) | undefined;
  const preparer: ContributionPreparer = {
    ...noJournalFacts,
    measure: async (request: ContributionRequest): Promise<ContributionMeasured> => {
      const seen: SeenRequest = { runId: request.runId, leading: [...request.leading] };
      requests.push(seen);
      const reply = replies.shift() ?? fallback;
      if (reply.kind === 'fail') throw reply.error;
      if (bound === undefined) throw new Error('the fake preparer was not bound to a store');
      const run = bound.getRun(request.runId);
      if (run === undefined) throw new Error(`the fake preparer measured an unknown run ${request.runId}`);
      const lastSeq = reply.kind === 'stale' ? run.lastSeq - 1 : run.lastSeq;
      action?.(seen, requests.length);
      return reply.kind === 'nothing' ? { lastSeq } : { lastSeq, contribution: contributionOf(reply.id) };
    },
  };
  return {
    preparer,
    requests,
    bind: (store) => {
      bound = store;
    },
    during: (next) => {
      action = next;
    },
  };
};
