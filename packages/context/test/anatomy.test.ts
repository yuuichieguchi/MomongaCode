import { describe, expect, it } from 'vitest';
import { buildContext, workingStateMessage } from '@momonga/context';
import type { TokenCounter } from '@momonga/context';
import type { FunctionTool, GoverningFactView, InputItem, MemoryView, MessageInputItem, TokenAnatomy } from '@momonga/protocol';
import { TEST_FENCE } from '@momonga/testkit';
import {
  PROJECT,
  READ_TOOL,
  ROOT_AGENTS,
  SYSTEM_PROMPT,
  TASK,
  assistant,
  call,
  capabilitiesFor,
  fakeCounter,
  harness,
  inputFor,
  output,
  sourcesWith,
  tokensOfItem,
  tokensOfTool,
  user,
} from './helpers.ts';

const WRITE_TOOL: FunctionTool = {
  type: 'function',
  name: 'Write',
  description: 'Write a file with the given content',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } },
};

const SKILL = { name: 'lint', content: 'Run the linter before you finish.' };
const ROOT_TEXT = 'Indent with tabs in every file.';
const WRAP_UP: MessageInputItem = { type: 'message', role: 'developer', content: 'Wrap up now and summarise what was done.' };

const capabilities = capabilitiesFor(100_000);

const layerSum = (anatomy: TokenAnatomy): number => {
  const { history, ...flat } = anatomy.layers;
  return Object.values(flat).reduce((sum, value) => sum + value, 0) + history.user + history.assistant + history.toolCalls + history.toolOutputs;
};

const developerMessageContaining = (items: readonly InputItem[], text: string): InputItem => {
  const found = items.find((item) => item.type === 'message' && item.role === 'developer' && JSON.stringify(item.content).includes(text));
  if (found === undefined) throw new Error(`no developer message containing ${text}`);
  return found;
};

const offsetCounter = (offset: number): TokenCounter => {
  const inner = fakeCounter();
  return {
    count: async (request) => {
      const counted = await inner.count(request);
      return { ...counted, input_tokens: counted.input_tokens + offset };
    },
  };
};

const richSources = () =>
  sourcesWith({
    tools: [READ_TOOL, WRITE_TOOL],
    activatedSkills: [SKILL],
    taskSeq: 10,
    history: [user(1, 'Which files changed yesterday?'), assistant(2, 'Two files changed.'), call(3, 'c1'), output(4, 'c1', 'the contents of the changed file')],
  });

describe('the anatomy of a built context', () => {
  it('attributes each layer the tokens of its own items, so a mislabelled layer shows a wrong share', async () => {
    const files = { [ROOT_AGENTS]: ROOT_TEXT };
    const built = await buildContext(inputFor(capabilities, { sources: richSources(), trailing: [WRAP_UP] }), harness(capabilities, { files }).ports);
    const history = richSources().history;

    expect(built.anatomy).toEqual({
      estimated: true,
      total: built.inputTokens,
      layers: {
        system: tokensOfItem({ type: 'message', role: 'system', content: SYSTEM_PROMPT }),
        tools: tokensOfTool(READ_TOOL) + tokensOfTool(WRITE_TOOL),
        instructions: tokensOfItem(developerMessageContaining(built.input, ROOT_TEXT)),
        skills: tokensOfItem(developerMessageContaining(built.input, SKILL.content)),
        governing: 0,
        memories: 0,
        summary: 0,
        workingState: 0,
        history: {
          user: tokensOfItem(TASK) + tokensOfItem(history[0]!.item),
          assistant: tokensOfItem(history[1]!.item),
          toolCalls: tokensOfItem(history[2]!.item),
          toolOutputs: tokensOfItem(history[3]!.item),
        },
        notices: tokensOfItem(WRAP_UP),
      },
      tools: { Read: tokensOfTool(READ_TOOL), Write: tokensOfTool(WRITE_TOOL) },
    });
  });

  it('counts the summary and the working state in their own layers, not in history', async () => {
    const summaryItem: MessageInputItem = { type: 'message', role: 'user', content: 'Summary: the parser was rewritten and its tests pass.' };
    const sources = sourcesWith({
      taskSeq: 0,
      summary: { item: summaryItem, replacedThroughSeq: 2 },
      workingState: () => 'Files written: src/parser.ts',
      history: [call(1, 'old'), output(2, 'old', 'old output'), assistant(3, 'Continuing with the parser.')],
    });
    const built = await buildContext(inputFor(capabilities, { sources }), harness(capabilities).ports);

    expect(built.anatomy.layers.summary).toBe(tokensOfItem(summaryItem));
    expect(built.anatomy.layers.workingState).toBe(tokensOfItem(workingStateMessage('Files written: src/parser.ts', TEST_FENCE)));
    expect(built.anatomy.layers.history).toEqual({ user: tokensOfItem(TASK), assistant: tokensOfItem(sources.history[2]!.item), toolCalls: 0, toolOutputs: 0 });
  });

  it('counts governing facts and recalled memories in their own layers, not as instructions or history', async () => {
    const rule = 'Never use pandas; use polars.';
    const memory: MemoryView = {
      id: 'mem-1',
      scope: 'project',
      origin: 'trusted',
      project: PROJECT,
      text: 'The team deploys with pnpm.',
      source: { kind: 'tool', sessionId: 's1', runId: 'run-1', step: 1, callId: 'c1', seq: 4 },
      createdAt: Date.UTC(2026, 10, 1),
      keptAt: Date.UTC(2026, 10, 2),
      kind: 'fact',
      state: 'active',
      duplicateOf: null,
      supersedes: [],
      supersededBy: [],
      retiredAt: null,
      evidence: [],
      contributedAt: null,
      keptByClassifier: null,
      status: 'unbound',
    };
    const fact: GoverningFactView = {
      id: 'g1',
      kind: 'constraint',
      target: 'pandas',
      text: rule,
      scope: { level: 'user' },
      validFrom: 1,
      validUntil: null,
      retiredAt: null,
      supersedes: [],
      enforcement: null,
      source: { kind: 'command', at: 1 },
    };
    const sources = sourcesWith({ governing: { active: [fact], conflicts: [] }, memories: [memory] });
    const built = await buildContext(inputFor(capabilities, { sources }), harness(capabilities).ports);
    const memoryMessage = built.input.find((item) => item.type === 'message' && typeof item.content === 'string' && item.content.includes('<recalled_memories>'));
    const governingMessage = built.input.find((item) => item.type === 'message' && JSON.stringify(item.content).includes(rule));

    expect(memoryMessage).toBeDefined();
    expect(governingMessage).toBeDefined();
    expect(governingMessage).not.toBe(memoryMessage);
    expect(built.anatomy.layers.memories).toBe(tokensOfItem(memoryMessage as InputItem));
    expect(built.anatomy.layers.governing).toBe(tokensOfItem(governingMessage as InputItem));
    expect(built.anatomy.layers.instructions).toBe(0);
    expect(built.anatomy.layers.history).toEqual({ user: tokensOfItem(TASK), assistant: 0, toolCalls: 0, toolOutputs: 0 });
  });

  it('sums exactly to the estimate of the request it describes, even when the meter is not additive per item', async () => {
    const files = { [ROOT_AGENTS]: ROOT_TEXT };
    const ports = harness(capabilities, { files, counter: Object.assign(offsetCounter(7), { calls: [] }) }).ports;
    const built = await buildContext(inputFor(capabilities, { sources: richSources(), trailing: [WRAP_UP] }), ports);

    expect(built.anatomy.total).toBe(built.inputTokens);
    expect(layerSum(built.anatomy)).toBe(built.inputTokens);
    expect(Object.values(built.anatomy.tools).reduce((sum, value) => sum + value, 0)).toBe(built.anatomy.layers.tools);
    const { history, ...flat } = built.anatomy.layers;
    for (const value of [...Object.values(flat), ...Object.values(history)]) {
      expect(Number.isInteger(value) && value >= 0).toBe(true);
    }
  });

  it('describes the input after eviction, so a share never counts the full text of an omitted output', async () => {
    const sources = sourcesWith({ taskSeq: 10, history: [call(1, 'big'), output(2, 'big', 'r'.repeat(4000))] });
    const built = await buildContext(inputFor(capabilities, { sources, evicted: new Set(['big']) }), harness(capabilities).ports);
    const rendered = built.input.find((item) => item.type === 'function_call_output');

    expect(built.anatomy.layers.history.toolOutputs).toBe(tokensOfItem(rendered as InputItem));
    expect(built.anatomy.layers.history.toolOutputs).toBeLessThan(tokensOfItem(output(2, 'big', 'r'.repeat(4000)).item));
  });
});
