import { testSecretLocations } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { decide, matchPathlessRule, parseRule, suggestAllowRule } from '@momonga/policy';
import type { PermissionRule, PermissionSubject, PolicyTool } from '@momonga/policy';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { TEST_SEARCH_PATH, fakePolicyFilesystem } from '@momonga/testkit';
import { createToolRegistry, extendToolSet } from '@momonga/tools';
import type { AnyTool, SubjectContext } from '@momonga/tools';
import { GENERAL_PURPOSE_AGENT } from '@momonga/agents';
import { createAgentTool } from '../src/tool.ts';
import type { AgentDefinition } from '@momonga/agents';

const HOME = '/home/u';
const PROJECT = '/work/app';

const REVIEWER: AgentDefinition = { ...GENERAL_PURPOSE_AGENT, name: 'reviewer', description: 'Reviews a change.', scope: 'user', location: `${HOME}/.momonga/agents/reviewer.md` };

const AGENT_TOOL = createAgentTool([GENERAL_PURPOSE_AGENT, REVIEWER], { spawn: async () => ({ state: 'running', runId: 'c', sessionId: 's' }) });

const POLICY_TOOL: PolicyTool = { name: 'Agent', kind: 'other', sideEffect: 'read_only' };

const rule = (effect: 'allow' | 'ask' | 'deny', text: string): PermissionRule =>
  parseRule(text, { effect, origin: 'user', source: 'user-settings', settingsRoot: PROJECT, home: HOME, cwd: PROJECT });

const subjectFor = (agent: string): PermissionSubject =>
  AGENT_TOOL.subject({ description: 'd', prompt: 'p', subagent_type: agent }, {} as SubjectContext);

const decideFor = async (agent: string, rules: PermissionRule[], mode: 'manual' | 'bypassPermissions' = 'manual') =>
  decide({
    secretLocations: testSecretLocations(HOME),
    tool: POLICY_TOOL,
    subject: subjectFor(agent),
    mode,
    rules,
    roots: [PROJECT],
    home: HOME,
    cwd: PROJECT,
    fileRules: { entries: [] } as never,
    protectedSet: EMPTY_PROTECTED_SET,
    fs: fakePolicyFilesystem(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: () => true,
  });

const offered = async (rules: PermissionRule[]) => {
  const set = extendToolSet(await createToolRegistry().snapshot({}), AGENT_TOOL as AnyTool);
  return set.forModel({ mode: 'manual', rules }).find((tool) => tool.name === 'Agent');
};

describe('a permission rule that names a subagent', () => {
  it('is accepted by the rule parser with the agent name as its specifier', () => {
    expect(rule('deny', 'Agent(general-purpose)')).toMatchObject({ tool: 'Agent', specifier: 'general-purpose' });
  });

  it('carries the agent of the call as the target of its permission subject', () => {
    expect(subjectFor('reviewer')).toEqual({ kind: 'agent', tool: 'Agent', agent: 'reviewer' });
  });

  it('refuses the built-in general-purpose agent with the denial of a rule and lets another agent run', async () => {
    const rules = [rule('deny', 'Agent(general-purpose)')];
    expect(await decideFor('general-purpose', rules)).toMatchObject({ kind: 'deny', denial: 'rule', source: 'rule' });
    expect(await decideFor('general-purpose', rules, 'bypassPermissions')).toMatchObject({ kind: 'deny' });
    expect((await decideFor('reviewer', rules)).kind).toBe('allow');
  });

  it('refuses a user-defined agent by its name and lets the built-in run', async () => {
    const rules = [rule('deny', 'Agent(reviewer)')];
    expect((await decideFor('reviewer', rules)).kind).toBe('deny');
    expect((await decideFor('general-purpose', rules)).kind).toBe('allow');
  });

  it('keeps a bare Agent deny refusing every agent', async () => {
    const rules = [rule('deny', 'Agent')];
    expect((await decideFor('reviewer', rules)).kind).toBe('deny');
    expect((await decideFor('general-purpose', rules)).kind).toBe('deny');
  });

  it('asks for the named agent only when an ask rule names it', async () => {
    const rules = [rule('ask', 'Agent(reviewer)')];
    expect(await decideFor('reviewer', rules)).toMatchObject({ kind: 'ask', source: 'rule' });
    expect((await decideFor('general-purpose', rules)).kind).toBe('allow');
  });

  it('matches an allow rule by the same matcher, by the agent named in it only', () => {
    const allow = rule('allow', 'Agent(review*)');
    expect(matchPathlessRule(allow, { kind: 'agent', tool: 'Agent', agent: 'reviewer' })).toBe(true);
    expect(matchPathlessRule(allow, { kind: 'agent', tool: 'Agent', agent: 'general-purpose' })).toBe(false);
  });

  it('suggests an allow rule that names the agent', async () => {
    expect(await suggestAllowRule(POLICY_TOOL, subjectFor('reviewer'), PROJECT, async (target) => ({ ok: true, path: target }) as never)).toBe('Agent(reviewer)');
  });

  it('takes a denied agent out of the description and the choices the model is offered', async () => {
    const tool = await offered([rule('deny', 'Agent(general-purpose)')]);
    expect(tool?.description).not.toContain('- general-purpose:');
    expect(tool?.description).toContain('- reviewer:');
    expect(tool?.parameters).toMatchObject({ properties: { subagent_type: { enum: ['reviewer'] } } });
  });

  it('offers every agent when an ask rule names one', async () => {
    const tool = await offered([rule('ask', 'Agent(general-purpose)')]);
    expect(tool?.parameters).toMatchObject({ properties: { subagent_type: { enum: ['general-purpose', 'reviewer'] } } });
  });

  it('does not offer the Agent tool when every agent is denied by name', async () => {
    expect(await offered([rule('deny', 'Agent(general-purpose)'), rule('deny', 'Agent(reviewer)')])).toBeUndefined();
  });
});
