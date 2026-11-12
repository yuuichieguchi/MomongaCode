import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, SkillFileSystem } from '@momonga/skills';
import { childResultOf, createAgentLoader, pinOf, readAgentPin } from '@momonga/agents';
import type { ChildRunOutcome } from '@momonga/agents';

const HOME = '/home/u';
const PROJECT = '/work/app';

const fileSystemOf = (files: Readonly<Record<string, string>>): SkillFileSystem => ({
  listDirectory: async (directory): Promise<DirectoryEntry[] | undefined> => {
    const names = Object.keys(files)
      .filter((file) => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes('/'))
      .map((file) => ({ name: file.slice(directory.length + 1), kind: 'file' as const }));
    return names.length === 0 ? undefined : names;
  },
  readText: async (file) => files[file],
  realpath: async (target) => target,
});

const agentFile = (name: string, extra: string) => `---\nname: ${name}\ndescription: ${name} agent\n${extra}---\nDo the work.\n`;

const load = (files: Record<string, string>) => createAgentLoader({ home: HOME, fileSystem: fileSystemOf(files) }).load({ projectRoot: PROJECT, trusted: true, projectAgentApproved: () => true });

type MandateHolder = { mandate?: { completion?: { conditions?: { command: string; when?: string }[]; requirements?: string[]; inherit?: boolean } } };

describe('completion conditions in agent front matter', () => {
  it('reads conditions and requirements into the mandate of the definition, each condition with when always', async () => {
    const set = await load({
      [`${PROJECT}/.momonga/agents/fixer.md`]: agentFile('fixer', 'conditions:\n  - npm test\n  - npm run lint\nrequirements:\n  - the changelog mentions the fix\n'),
    });
    expect(set.warnings).toEqual([]);
    const [agent] = set.agents;
    expect((agent as unknown as MandateHolder).mandate?.completion).toMatchObject({
      conditions: [
        { command: 'npm test', when: 'always' },
        { command: 'npm run lint', when: 'always' },
      ],
      requirements: ['the changelog mentions the fix'],
    });
  });

  it('reads inherit false from the front matter', async () => {
    const set = await load({ [`${PROJECT}/.momonga/agents/fixer.md`]: agentFile('fixer', 'conditions:\n  - npm test\ninherit: false\n') });
    expect(set.warnings).toEqual([]);
    expect((set.agents[0] as unknown as MandateHolder).mandate?.completion?.inherit).toBe(false);
  });

  it('skips a definition whose conditions are not a list of non-empty strings', async () => {
    const set = await load({ [`${PROJECT}/.momonga/agents/fixer.md`]: agentFile('fixer', 'conditions: 3\n') });
    expect(set.agents).toEqual([]);
    expect(set.warnings.join('\n')).toContain('conditions');
  });

  it('pins the mandate with the definition and reads it back', async () => {
    const set = await load({ [`${PROJECT}/.momonga/agents/fixer.md`]: agentFile('fixer', 'conditions:\n  - npm test\n') });
    const [agent] = set.agents;
    if (agent === undefined) throw new Error('the agent was not loaded');
    const pin = pinOf(agent);
    expect((pin as unknown as MandateHolder).mandate?.completion?.conditions).toMatchObject([{ command: 'npm test' }]);
    expect(readAgentPin({ agent: JSON.parse(JSON.stringify(pin)) })).toEqual(pin);
  });

  it('gives the Agent tool no completion or mandate field, so the model cannot declare or weaken a condition', async () => {
    const set = await load({ [`${PROJECT}/.momonga/agents/fixer.md`]: agentFile('fixer', 'conditions:\n  - npm test\n') });
    const tool = set.tool({ spawn: async () => ({ state: 'running', runId: 'r', sessionId: 's' }) });
    const schema = tool?.inputSchema as { properties: Record<string, unknown>; additionalProperties: boolean } | undefined;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(['description', 'prompt', 'subagent_type']);
    expect(schema?.additionalProperties).toBe(false);
    expect((set.agents[0] as unknown as MandateHolder).mandate?.completion?.conditions).toHaveLength(1);
  });
});

describe('the child result of a run that ended with unmet conditions', () => {
  it('fails the call and names the failing condition from the child report', () => {
    const outcome = {
      state: 'finished',
      runId: 'child-1',
      sessionId: 's-child',
      status: 'STOPPED',
      stopReason: 'conditions_unmet',
      text: 'I am done.',
      report: {
        conditions: [
          { id: 'a', command: 'npm test', state: 'failed', rounds: 2, last: { seq: 9, exitCode: 1, durationMs: 4, mutationSeq: 7 } },
          { id: 'b', command: 'npm run lint', state: 'passed', rounds: 2, last: { seq: 10, exitCode: 0, durationMs: 4, mutationSeq: 7 } },
        ],
        notRun: [],
        residualRisk: [],
      },
    } as unknown as Extract<ChildRunOutcome, { state: 'finished' }>;
    const result = childResultOf('fixer', outcome);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('conditions_unmet');
    expect(result.output).toContain('npm test');
    expect(result.output).toMatch(/npm test[^\n]*failed[^\n]*exit 1|npm test[^\n]*exit 1[^\n]*failed/);
    expect(result.output).not.toMatch(/npm run lint[^\n]*failed/);
  });

  it('reports a completed child with its passed conditions, never on its own word', () => {
    const outcome = {
      state: 'finished',
      runId: 'child-1',
      sessionId: 's-child',
      status: 'COMPLETED',
      text: 'All good.',
      report: { conditions: [{ id: 'a', command: 'npm test', state: 'passed', rounds: 1, last: { seq: 9, exitCode: 0, durationMs: 4, mutationSeq: 7 } }], notRun: [], residualRisk: [] },
    } as unknown as Extract<ChildRunOutcome, { state: 'finished' }>;
    const result = childResultOf('fixer', outcome);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('All good.');
    expect(result.output).toMatch(/npm test[^\n]*passed/);
  });
});
