import type { Mandate, ReasoningEffort, RunReport } from '@momonga/protocol';
import type { AnyTool } from '@momonga/tools';

export type AgentFileScope = 'project' | 'user';

export type AgentScope = AgentFileScope | 'builtin';

type AgentFields = {
  name: string;
  description: string;
  prompt: string;
  tools?: readonly string[];
  model?: string;
  effort?: ReasoningEffort;
  mandate?: Mandate;
};

export type BuiltInAgentDefinition = AgentFields & { scope: 'builtin' };

export type FileAgentDefinition = AgentFields & { scope: AgentFileScope; location: string };

export type AgentDefinition = BuiltInAgentDefinition | FileAgentDefinition;

export type AgentPin = {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  effort?: ReasoningEffort;
  mandate?: Mandate;
};

export type ChildRunOutcome =
  | { state: 'running'; runId: string; sessionId: string }
  | {
      state: 'finished';
      runId: string;
      sessionId: string;
      status: 'COMPLETED' | 'STOPPED' | 'FAILED' | 'CANCELLED';
      stopReason?: string;
      error?: { code: string; message: string };
      text: string;
      report?: RunReport;
    };

export type ChildRunRequest = { parentRunId: string; parentCallId: string; agent: AgentDefinition; prompt: string; effort?: ReasoningEffort };

export type ChildRunSpawner = { spawn(request: ChildRunRequest): Promise<ChildRunOutcome> };

export type ChildRuns = ChildRunSpawner & { outcomeOf(runId: string): Promise<ChildRunOutcome> };

export type AgentSet = {
  agents: readonly AgentDefinition[];
  pendingApproval: readonly ProjectAgentFile[];
  warnings: readonly string[];
  tool(runs: ChildRunSpawner): AnyTool;
};

export type ProjectAgentFile = { name: string; text: string; source: string };

export type ProjectAgentApproved = (agent: { name: string; text: string }) => boolean;

export type AgentLoadRequest = { projectRoot: string; trusted: boolean; projectAgentApproved: ProjectAgentApproved; signal: AbortSignal };

export type AgentLoader = { load(request: AgentLoadRequest): Promise<AgentSet> };

export class ChildRunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChildRunError';
  }
}
