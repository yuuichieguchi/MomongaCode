import { checkGoverningFact, normalizeTarget } from '@momonga/memory';
import type { GoverningFactView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { ToolExecutionError, createGovernanceTools } from '@momonga/tools';
import type { GovernancePort as GovernanceToolPort } from '@momonga/tools';
import type { GovernancePort, SettingsPort } from '../ports.ts';
import { callSeqOf } from '../process/run-events.ts';
import { ruleParses } from './rules.ts';

export type GovernancePortOptions = {
  store: Pick<RuntimeStore, 'governing' | 'readRunEvents'>;
  settings: Pick<SettingsPort, 'trusted'>;
};

export const createGovernancePort = ({ store, settings }: GovernancePortOptions): GovernancePort => ({
  load: (session) => {
    const toolPort: GovernanceToolPort = {
      propose: (request) => {
        const scope: GoverningFactView['scope'] = request.scope === 'user' ? { level: 'user' } : { level: 'project', project: session.cwd, paths: request.paths ?? [] };
        const target = normalizeTarget(request.target);
        const enforcement = request.enforcement ?? null;
        const supersedes = request.supersedes ?? [];
        const seq = callSeqOf(store, request.runId, request.callId);
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
        const checked = checkGoverningFact(candidate, { existing: store.governing.list({ project: session.cwd }), parses: ruleParses });
        if (!checked.ok) throw new ToolExecutionError(checked.message);
        const { fact, created } = store.governing.add({ kind: request.kind, target, text: request.text, scope, validUntil: null, supersedes, enforcement, source });
        return { factId: fact.id, created };
      },
    };
    return { tools: createGovernanceTools({ port: toolPort, trusted: settings.trusted(session) }) };
  },
});
