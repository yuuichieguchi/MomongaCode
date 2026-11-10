import type { RunReport } from '@momonga/protocol';
import { defineTool, ToolExecutionError } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { AGENT_TOOL_NAME, SPAWN_TOOL_TIMEOUT_MS } from './constants.ts';
import { ChildRunError } from './types.ts';
import type { AgentDefinition, ChildRunOutcome, ChildRunSpawner } from './types.ts';

type AgentInput = { description: string; prompt: string; subagent_type: string };

const oneLine = (value: string): string => value.replace(/\s+/g, ' ');

const reportLinesOf = (report: RunReport | undefined): string => {
  if (report === undefined) return '';
  const conditions = report.conditions.map(
    (condition) => `- ${condition.command}: ${condition.state}${condition.last?.exitCode === undefined ? '' : ` (exit ${condition.last.exitCode})`}`,
  );
  const risks = report.residualRisk.map((risk) => `- ${risk.code}: ${risk.count}`);
  return [
    ...(conditions.length === 0 ? [] : ['Completion conditions:', ...conditions]),
    ...(risks.length === 0 ? [] : ['Residual risk:', ...risks]),
  ].join('\n');
};

const withReport = (text: string, report: RunReport | undefined): string => {
  const lines = reportLinesOf(report);
  return lines === '' ? text : `${text}\n${lines}`;
};

export const childResultOf = (agent: string, outcome: Extract<ChildRunOutcome, { state: 'finished' }>): { status: 'completed' | 'failed'; output: string } => {
  const lastMessage = outcome.text === '' ? '' : `\nIts last message:\n${outcome.text}`;
  switch (outcome.status) {
    case 'COMPLETED':
      return { status: 'completed', output: withReport(outcome.text === '' ? `Subagent ${agent} finished without a final message.` : outcome.text, outcome.report) };
    case 'STOPPED':
      return { status: 'failed', output: `${withReport(`Subagent ${agent} stopped before it finished (${outcome.stopReason ?? 'no reason recorded'}).`, outcome.report)}${lastMessage}` };
    case 'FAILED':
      return { status: 'failed', output: `${withReport(`Subagent ${agent} failed${outcome.error === undefined ? '' : ` (${outcome.error.code}: ${outcome.error.message})`}.`, outcome.report)}${lastMessage}` };
    case 'CANCELLED':
      return { status: 'failed', output: `${withReport(`Subagent ${agent} was cancelled.`, outcome.report)}${lastMessage}` };
  }
};

export const childToolResultOf = (
  agent: string,
  outcome: Extract<ChildRunOutcome, { state: 'finished' }>,
): { status: 'completed' | 'failed'; output: string; mutated?: true } => ({
  ...childResultOf(agent, outcome),
  ...(outcome.report !== undefined && outcome.report.changes.mutatingCalls > 0 ? { mutated: true as const } : {}),
});

export const createAgentTool = (agents: readonly AgentDefinition[], runs: ChildRunSpawner): AnyTool => {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  return defineTool<AgentInput>({
    name: AGENT_TOOL_NAME,
    description: [
      'Delegates a task to a subagent that works in its own context with its own tools and returns its final message as the result. Give the subagent everything it needs in prompt, because it cannot see this conversation. Several Agent calls in one response run as parallel subagents.',
      'Available subagents:',
      ...agents.map((agent) => `- ${agent.name}: ${oneLine(agent.description)}`),
    ].join('\n'),
    conciseDescription: `Delegates a task to a subagent that works in its own context and returns its final message. Put everything it needs in prompt. Subagents: ${agents.map((agent) => agent.name).join(', ')}`,
    conciseParameterDescriptions: { description: 'Short task summary', prompt: 'Task for the subagent', subagent_type: 'Subagent to use' },
    kind: 'other',
    sideEffect: 'read_only',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', minLength: 1, description: 'A short description of the task' },
        prompt: { type: 'string', minLength: 1, description: 'The task for the subagent' },
        subagent_type: { type: 'string', enum: agents.map((agent) => agent.name), description: 'The subagent to use' },
      },
      required: ['description', 'prompt', 'subagent_type'],
      additionalProperties: false,
    },
    timeoutMs: SPAWN_TOOL_TIMEOUT_MS,
    title: (input) => input.description,
    subject: () => ({ kind: 'none', tool: AGENT_TOOL_NAME }),
    execute: async (input, ctx) => {
      const agent = byName.get(input.subagent_type);
      if (agent === undefined) throw new ToolExecutionError(`Unknown subagent "${input.subagent_type}"`);
      let outcome: ChildRunOutcome;
      try {
        outcome = await runs.spawn({ parentRunId: ctx.runId, parentCallId: ctx.callId, agent, prompt: input.prompt });
      } catch (error) {
        if (error instanceof ChildRunError) throw new ToolExecutionError(error.message);
        throw error;
      }
      if (outcome.state === 'running') {
        return { status: 'pending', awaits: { kind: 'run', runId: outcome.runId, sessionId: outcome.sessionId, agent: agent.name }, wakeAt: ctx.deadlineAt };
      }
      return childToolResultOf(agent.name, outcome);
    },
    reconcile: async () => ({ outcome: 'not_applied', output: '' }),
  });
};
