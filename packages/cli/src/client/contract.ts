import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { RUN_API_SCHEMAS } from '@momonga/protocol';
import type { AgentsResponse, ContextChargeResponse, CostReportView, GuidelineResponse, GuidelinesResponse, JobsResponse, MemoriesResponse, MemoryResponse, McpAuthorizationView, McpServerView, PolicyGovernanceResponse, PromoteMemoryResponse, PublicRunEvent, RuleAddResponse, RuleResponse, RulesResponse, RunHealth, RunTraceView, SkillsResponse } from '@momonga/protocol';
import type { ApprovalView, ElicitationView, ErrorBody, RunView, SessionView, TrustView } from './views.ts';

export class ContractViolation extends Error {
  constructor(description: string, detail: string) {
    super(`${description} answered a body that does not match the Run API contract: ${detail}`);
    this.name = 'ContractViolation';
  }
}

const ajv = new Ajv2020.default({ strict: false, allErrors: true });

const guard = <T>(schema: Parameters<typeof ajv.compile>[0]): ((value: unknown, description: string) => T) => {
  const validate: ValidateFunction<T> = ajv.compile<T>(schema);
  return (value, description) => {
    if (!validate(value)) throw new ContractViolation(description, ajv.errorsText(validate.errors, { dataVar: 'body' }));
    return value;
  };
};

export const checkSession = guard<SessionView>(RUN_API_SCHEMAS.SessionView);
export const checkRun = guard<RunView>(RUN_API_SCHEMAS.RunView);
export const checkApproval = guard<ApprovalView>(RUN_API_SCHEMAS.ApprovalView);
export const checkTrust = guard<TrustView>(RUN_API_SCHEMAS.TrustView);
export const checkErrorBody = guard<ErrorBody>(RUN_API_SCHEMAS.ErrorBody);
export const checkHealth = guard<RunHealth>(RUN_API_SCHEMAS.Health);
export const checkRunEvent = guard<PublicRunEvent>(RUN_API_SCHEMAS.PublicRunEvent);
export const checkTrace = guard<RunTraceView>(RUN_API_SCHEMAS.RunTrace);
export const checkSkills = guard<SkillsResponse>(RUN_API_SCHEMAS.SkillsResponse);
export const checkAgents = guard<AgentsResponse>(RUN_API_SCHEMAS.AgentsResponse);
export const checkJobs = guard<JobsResponse>(RUN_API_SCHEMAS.JobsResponse);
export const checkElicitation = guard<ElicitationView>(RUN_API_SCHEMAS.ElicitationView);
export const checkMcpServers = guard<{ servers: McpServerView[] }>(RUN_API_SCHEMAS.McpServersResponse);
export const checkMcpAuthorization = guard<McpAuthorizationView>(RUN_API_SCHEMAS.McpAuthorizationView);
export const checkMemories = guard<MemoriesResponse>(RUN_API_SCHEMAS.MemoriesResponse);
export const checkMemory = guard<MemoryResponse>(RUN_API_SCHEMAS.MemoryResponse);
export const checkPromoted = guard<PromoteMemoryResponse>(RUN_API_SCHEMAS.PromoteMemoryResponse);
export const checkRuleAdd = guard<RuleAddResponse>(RUN_API_SCHEMAS.RuleAddResponse);
export const checkRule = guard<RuleResponse>(RUN_API_SCHEMAS.RuleResponse);
export const checkRules = guard<RulesResponse>(RUN_API_SCHEMAS.RulesResponse);
export const checkPolicyGovernance = guard<PolicyGovernanceResponse>(RUN_API_SCHEMAS.PolicyGovernanceResponse);
export const checkCostReport = guard<CostReportView>(RUN_API_SCHEMAS.CostReport);
export const checkGuidelines = guard<GuidelinesResponse>(RUN_API_SCHEMAS.GuidelinesResponse);
export const checkGuideline = guard<GuidelineResponse>(RUN_API_SCHEMAS.GuidelineResponse);
export const checkContextCharge = guard<ContextChargeResponse>(RUN_API_SCHEMAS.ContextChargeResponse);

export const compileRequestedSchema = (schema: Readonly<Record<string, unknown>>): ValidateFunction => ajv.compile(schema);
