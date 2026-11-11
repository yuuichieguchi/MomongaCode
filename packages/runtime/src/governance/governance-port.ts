import { checkGoverningFact, normalizeTarget } from '@momonga/memory';
import type { GoverningFactView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { ToolExecutionError, createGovernanceTools } from '@momonga/tools';
import type { GovernancePort as GovernanceToolPort } from '@momonga/tools';
import type { GovernancePort, SettingsPort } from '../ports.ts';
import { ruleParses } from './rules.ts';

export type GovernancePortOptions = {
  store: Pick<RuntimeStore, 'governing' | 'toolCallSeq'>;
  settings: Pick<SettingsPort, 'trusted'>;
};

export const createGovernancePort = ({ store, settings }: GovernancePortOptions): GovernancePort => ({
  load: async (session, signal) => {
    const find = (runId: string, callId: string): { factId: string } | undefined => {
      const recorded = store.governing.list().find((fact) => fact.source.kind === 'proposal' && fact.source.runId === runId && fact.source.callId === callId);
      return recorded === undefined ? undefined : { factId: recorded.id };
    };
    const toolPort: GovernanceToolPort = {
      find,
      propose: async (request) => {
        const replayed = find(request.runId, request.callId);
        if (replayed !== undefined) return { factId: replayed.factId, created: false };
        const scope: GoverningFactView['scope'] = request.scope === 'user' ? { level: 'user' } : { level: 'project', project: session.cwd, paths: request.paths ?? [] };
        const target = normalizeTarget(request.target);
        const enforcement = request.enforcement ?? null;
        const supersedes = request.supersedes ?? [];
        const seq = await store.toolCallSeq(request.runId, request.callId);
        if (seq === undefined) throw new Error(`run ${request.runId} has no tool.call event for ${request.callId}`);
        const source = { kind: 'proposal' as const, sessionId: session.id, runId: request.runId, seq, callId: request.callId };
        const candidate: GoverningFactView = {
          id: '',
          kind: request.kind,
          target,
          text: request.text,
          scope,
          validFrom: 0,
          validUntil: null,
          retiredAt: null,
          supersedes,
          enforcement,
          source,
        };
        const added = store.governing.addAdmitted(
          { kind: request.kind, target, text: request.text, scope, validUntil: null, supersedes, enforcement, source },
          (existing) => checkGoverningFact(candidate, { existing, parses: ruleParses }),
        );
        if (added.kind === 'refused') throw new ToolExecutionError(added.message);
        return { factId: added.fact.id, created: added.created };
      },
    };
    return { tools: createGovernanceTools({ port: toolPort, trusted: await settings.trusted(session, signal) }) };
  },
});
