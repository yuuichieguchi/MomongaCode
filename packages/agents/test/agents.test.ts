import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, SkillFileSystem } from '@momonga/skills';
import { AGENT_TOOL_NAME, ChildRunError, agentSystemPrompt, childToolResultOf, createAgentLoader, pinOf, readAgentPin } from '@momonga/agents';
import type { ChildRunOutcome, ChildRuns } from '@momonga/agents';
import type { ToolContext } from '@momonga/tools';
import { testPaths } from '@momonga/testkit';
import type { RunReport } from '@momonga/protocol';

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

const agentFile = (name: string, description: string, extra = '', body = 'Do the work.') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;

const load = (files: Record<string, string>, trusted = true) => createAgentLoader({ home: HOME, fileSystem: fileSystemOf(files) }).load({ projectRoot: PROJECT, trusted, projectAgentApproved: () => true, signal: new AbortController().signal });

describe('a project agent runs only as the person approved it', () => {
  const TEXT = agentFile('reviewer', 'Reviews', 'tools: Read, Bash\n');
  const CHANGED = agentFile('reviewer', 'Reviews', 'tools: Read, Bash, Write\n');
  const loadApproved = (text: string, approved: readonly { name: string; text: string }[]) =>
    createAgentLoader({ home: HOME, fileSystem: fileSystemOf({ [`${PROJECT}/.momonga/agents/reviewer.md`]: text, [`${HOME}/.momonga/agents/writer.md`]: agentFile('writer', 'Writes') }) }).load({ projectRoot: PROJECT, trusted: true, projectAgentApproved: (agent) => approved.some((entry) => entry.name === agent.name && entry.text === agent.text), signal: new AbortController().signal });

  it('does not offer or spawn a changed project agent with tools until its current file is approved, and lists it for the question', async () => {
    const set = await loadApproved(CHANGED, [{ name: 'reviewer', text: TEXT }]);
    expect(set.agents.map((agent) => agent.name)).toEqual(['general-purpose', 'writer']);
    expect(set.pendingApproval).toEqual([{ name: 'reviewer', text: CHANGED, source: `${PROJECT}/.momonga/agents/reviewer.md` }]);
    expect(set.warnings).toEqual([`Agent "reviewer" at ${PROJECT}/.momonga/agents/reviewer.md is not run until it is approved: it is new, or changed since it was approved`]);
    const approved = await loadApproved(CHANGED, [{ name: 'reviewer', text: CHANGED }]);
    expect(approved.agents.map((agent) => agent.name)).toEqual(['general-purpose', 'reviewer', 'writer']);
    expect(approved.pendingApproval).toEqual([]);
  });

  it('does not let a user agent of the same name stand in for a project agent that waits for its approval', async () => {
    const set = await createAgentLoader({ home: HOME, fileSystem: fileSystemOf({ [`${PROJECT}/.momonga/agents/a.md`]: agentFile('a', 'project one'), [`${HOME}/.momonga/agents/a.md`]: agentFile('a', 'user one') }) }).load({ projectRoot: PROJECT, trusted: true, projectAgentApproved: () => false, signal: new AbortController().signal });
    expect(set.agents.map((agent) => agent.scope)).toEqual(['builtin']);
  });
});

describe('agent definitions', () => {
  it('reads name, description, tools and model from both scopes', async () => {
    const set = await load({
      [`${PROJECT}/.momonga/agents/reviewer.md`]: agentFile('reviewer', 'Reviews code', 'tools: Read, Grep\nmodel: fast\n', 'Review carefully.'),
      [`${HOME}/.momonga/agents/writer.md`]: agentFile('writer', 'Writes docs', 'tools:\n  - Read\n  - Write\nmodel: inherit\n'),
    });
    expect(set.warnings).toEqual([]);
    expect(set.agents).toMatchObject([
      { name: 'general-purpose', scope: 'builtin' },
      { name: 'reviewer', description: 'Reviews code', tools: ['Read', 'Grep'], model: 'fast', prompt: 'Review carefully.', scope: 'project' },
      { name: 'writer', tools: ['Read', 'Write'], scope: 'user' },
    ]);
    expect(set.agents[2]?.model).toBeUndefined();
  });

  it.each([["an empty string", 'tools: ""\n'], ['a blank list', 'tools: " , "\n'], ['an empty list', 'tools: []\n']])('reads %s of tools as no tools line: the agent inherits the tools', async (_label, line) => {
    const absent = await load({ [`${HOME}/.momonga/agents/r.md`]: agentFile('r', 'd') });
    const empty = await load({ [`${HOME}/.momonga/agents/r.md`]: agentFile('r', 'd', line) });
    expect(empty.warnings).toEqual([]);
    expect(empty.agents).toEqual(absent.agents);
    expect(empty.agents[1]?.tools).toBeUndefined();
  });

  it('skips project agents of an untrusted folder and says so', async () => {
    const set = await load({ [`${PROJECT}/.momonga/agents/a.md`]: agentFile('a', 'A'), [`${HOME}/.momonga/agents/b.md`]: agentFile('b', 'B') }, false);
    expect(set.agents.map((agent) => agent.name)).toEqual(['general-purpose', 'b']);
    expect(set.warnings).toEqual([`Project agents in ${PROJECT}/.momonga/agents were skipped because the folder is not trusted`]);
  });

  it('lets the project agent win a name clash and warns', async () => {
    const set = await load({ [`${PROJECT}/.momonga/agents/a.md`]: agentFile('a', 'project one'), [`${HOME}/.momonga/agents/a.md`]: agentFile('a', 'user one') });
    expect(set.agents).toMatchObject([{ name: 'general-purpose' }, { name: 'a', description: 'project one' }]);
    expect(set.warnings).toEqual([`Agent "a" at ${HOME}/.momonga/agents/a.md was ignored because ${PROJECT}/.momonga/agents/a.md takes precedence`]);
  });

  it('skips invalid files with a reason and warns about unsupported fields', async () => {
    const set = await load({
      [`${HOME}/.momonga/agents/nodesc.md`]: '---\nname: x\n---\nbody\n',
      [`${HOME}/.momonga/agents/noname.md`]: '---\ndescription: d\n---\nbody\n',
      [`${HOME}/.momonga/agents/colon.md`]: agentFile('a:b', 'd'),
      [`${HOME}/.momonga/agents/nobody.md`]: '---\nname: nb\ndescription: d\n---\n',
      [`${HOME}/.momonga/agents/badtools.md`]: '---\nname: bt\ndescription: d\ntools: 5\n---\nbody\n',
      [`${HOME}/.momonga/agents/plain.txt`]: 'ignored',
      [`${HOME}/.momonga/agents/fancy.md`]: agentFile('fancy', 'd', 'permissionMode: bypassPermissions\ncolor: red\n'),
    });
    const text = set.warnings.join('\n');
    expect(set.agents.map((agent) => agent.name)).toEqual(['general-purpose', 'fancy']);
    expect(text).toContain('the description is missing or empty');
    expect(text).toContain('the name is missing or empty');
    expect(text).toContain('must not contain ":"');
    expect(text).toContain('no instructions');
    expect(text).toContain('tools must be');
    expect(text).toContain('"permissionMode", which is not supported and was ignored');
    expect(text).not.toContain('"color"');
  });
});

describe('agent pins', () => {
  it('round trips a definition and refuses a malformed pin', async () => {
    const set = await load({ [`${HOME}/.momonga/agents/r.md`]: agentFile('r', 'd', 'tools: Read\nmodel: fast\n', 'Prompt.') });
    const pin = pinOf(set.agents[1] as NonNullable<(typeof set.agents)[1]>);
    expect(readAgentPin({ agent: pin })).toEqual({ name: 'r', description: 'd', prompt: 'Prompt.', tools: ['Read'], model: 'fast' });
    expect(readAgentPin({})).toBeUndefined();
    await expect((async () => readAgentPin({ agent: { name: 1 } }))()).rejects.toThrow('malformed');
    await expect((async () => readAgentPin({ agent: { ...pin, tools: [1] } }))()).rejects.toThrow('tools');
    expect(agentSystemPrompt('base', pin)).toContain('subagent "r"');
    expect(agentSystemPrompt('base', pin).endsWith('Prompt.')).toBe(true);
  });

  it('round trips the effort of a definition and refuses a pin with an unknown effort', async () => {
    const set = await load({ [`${HOME}/.momonga/agents/r.md`]: agentFile('r', 'd', 'effort: high\n', 'Prompt.') });
    const pin = pinOf(set.agents[1] as NonNullable<(typeof set.agents)[1]>);
    expect(readAgentPin({ agent: pin })).toEqual({ name: 'r', description: 'd', prompt: 'Prompt.', effort: 'high' });
    await expect((async () => readAgentPin({ agent: { ...pin, effort: 'huge' } }))()).rejects.toThrow('effort');
  });
});

describe('the effort of an agent definition', () => {
  it('accepts a level of the reasoning effort ladder without a warning', async () => {
    const set = await load({ [`${HOME}/.momonga/agents/r.md`]: agentFile('r', 'd', 'effort: low\n', 'Prompt.') });
    expect(set.agents.find((agent) => agent.name === 'r')?.effort).toBe('low');
    expect(set.warnings).toEqual([]);
  });

  it('skips a definition whose effort is not a level, saying which levels exist', async () => {
    const set = await load({ [`${HOME}/.momonga/agents/r.md`]: agentFile('r', 'd', 'effort: huge\n', 'Prompt.') });
    expect(set.agents.some((agent) => agent.name === 'r')).toBe(false);
    expect(set.warnings).toEqual([`Agent at ${HOME}/.momonga/agents/r.md was skipped: effort must be one of none, minimal, low, medium, high, xhigh, max`]);
  });
});

describe('the Agent tool', () => {
  const context = { runId: 'run-1', callId: 'call-1', deadlineAt: 99 } as ToolContext;
  const input = { description: 'd', prompt: 'p', subagent_type: 'r' };
  const toolWith = async (spawn: ChildRuns['spawn']) => {
    const set = await load({ [`${HOME}/.momonga/agents/r.md`]: agentFile('r', '"Reviews\\ncode"') });
    return set.tool({ spawn });
  };
  const running = async (): Promise<ChildRunOutcome> => ({ state: 'running', runId: 'c', sessionId: 's' });

  it('lists the agents, constrains subagent_type and needs no permission', async () => {
    const tool = await toolWith(running);
    expect(tool.name).toBe(AGENT_TOOL_NAME);
    expect(tool.description).toContain('- r: Reviews code');
    expect(tool.inputSchema).toMatchObject({ properties: { subagent_type: { enum: ['general-purpose', 'r'] } }, required: ['description', 'prompt', 'subagent_type'] });
    expect(tool.sideEffect).toBe('read_only');
    expect(tool.subject({}, { paths: testPaths(), cwd: '/', workingDirectory: '/', home: HOME, roots: [] })).toEqual({ kind: 'agent', tool: 'Agent', agent: undefined });
  });

  it('asks to wait for a running child, keyed by the call, until the run deadline', async () => {
    const requests: unknown[] = [];
    const tool = await toolWith(async (request) => {
      requests.push({ parent: request.parentRunId, call: request.parentCallId, agent: request.agent.name, prompt: request.prompt });
      return { state: 'running', runId: 'child', sessionId: 'cs' };
    });
    expect(await tool.execute(input, context, undefined)).toEqual({ status: 'pending', awaits: { kind: 'run', runId: 'child', sessionId: 'cs', agent: 'r' }, wakeAt: 99 });
    expect(requests).toEqual([{ parent: 'run-1', call: 'call-1', agent: 'r', prompt: 'p' }]);
  });

  it('accepts an effort level and passes it to the child it starts, and refuses a word that is not a level', async () => {
    const efforts: unknown[] = [];
    const tool = await toolWith(async (request) => {
      efforts.push(request.effort);
      return { state: 'running', runId: 'child', sessionId: 'cs' };
    });
    expect(tool.inputSchema).toMatchObject({ properties: { effort: { enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] } } });
    await tool.execute({ ...input, effort: 'high' }, context, undefined);
    await tool.execute(input, context, undefined);
    expect(efforts).toEqual(['high', undefined]);
  });

  type Finished = Extract<ChildRunOutcome, { state: 'finished' }>;
  const finished = (status: Finished['status'], extra: Partial<Finished> = {}): ChildRunOutcome => ({
    state: 'finished',
    runId: 'c',
    sessionId: 's',
    status,
    text: 'final words',
    ...extra,
  });

  it.each([
    [finished('COMPLETED'), 'completed', 'final words'],
    [finished('COMPLETED', { text: '' }), 'completed', 'Subagent r finished without a final message.'],
    [finished('STOPPED', { stopReason: 'budget' }), 'failed', 'Subagent r stopped before it finished (budget).\nIts last message:\nfinal words'],
    [finished('FAILED', { error: { code: 'x', message: 'y' } }), 'failed', 'Subagent r failed (x: y).\nIts last message:\nfinal words'],
    [finished('CANCELLED', { text: '' }), 'failed', 'Subagent r was cancelled.'],
  ])('reports a finished child %#', async (outcome, status, output) => {
    const tool = await toolWith(async () => outcome);
    expect(await tool.execute(input, context, undefined)).toEqual({ status, output });
  });

  it('gives the parent the paths the child wrote with its completion', () => {
    const report = { conditions: [], residualRisk: [], changes: { files: [{ path: '/p/package.json', sha256: 'abc', lastSeq: 4 }, { path: '/p/notes.txt', lastSeq: 6 }], mutatingCalls: 2 } };
    const outcome = finished('COMPLETED', { report: report as unknown as RunReport });
    if (outcome.state !== 'finished') throw new Error('expected a finished child');
    expect(childToolResultOf('r', outcome)).toEqual({
      status: 'completed',
      output: expect.any(String),
      mutated: true,
      files: [
        { path: '/p/package.json', sha256: 'abc', access: 'write' },
        { path: '/p/notes.txt', access: 'write' },
      ],
    });
  });

  it('turns a refusal to start into a tool error and lets other errors through', async () => {
    const refusing = await toolWith(async () => {
      throw new ChildRunError('the run is CANCELLING');
    });
    await expect(refusing.execute(input, context, undefined)).rejects.toMatchObject({ name: 'ToolExecutionError', message: 'the run is CANCELLING' });
    const broken = await toolWith(async () => {
      throw new Error('disk');
    });
    await expect(broken.execute(input, context, undefined)).rejects.toThrow('disk');
  });
});
