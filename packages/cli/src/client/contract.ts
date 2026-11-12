import type { TrustItemsView } from '@momonga/protocol';
import { defineProductSchema, productErrorsText } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { REPORT_SCHEMAS, RUN_API_SCHEMAS, runApiSchemaName } from '@momonga/protocol';
import type { ReportCostPage, ReviewPage, StoreReviewResponse, TraceContentPage } from '@momonga/protocol';
import type { AgentsResponse, ContextChargeResponse, InboxAddResponse, InboxResponse, InboxWithdrawResponse, CostBreakdownView, CostReportView, GuidelineResponse, GuidelinesResponse, JobsResponse, JsonSchema, MemoriesResponse, MemoryResponse, McpAuthorizationView, McpServerView, PolicyGovernanceResponse, PolicyVerifyResponse, PromoteMemoryResponse, PublicRunEvent, PublicStreamEvent, ReflectionResponse, ReportPage, ReportRecomputePage, RuleAddResponse, RuleResponse, RulesResponse, RunAnsweredByView, RunHealth, RunReflectionView, RunTraceView, SkillsResponse, UserShellFrame, UserShellPendingResponse } from '@momonga/protocol';
import type { ApprovalView, ElicitationView, ErrorBody, RunView, SessionView, TrustView } from './views.ts';

export class ContractViolation extends Error {
  constructor(description: string, detail: string) {
    super(`${description} answered a body that does not match the Run API contract: ${detail}`);
    this.name = 'ContractViolation';
  }
}

const guard = <T>(schema: JsonSchema): ((value: unknown, description: string) => T) => {
  const validate: ProductValidator<T> = defineProductSchema(`run-api/${runApiSchemaName(schema)}`, schema);
  return (value, description) => {
    const verdict = validate(value);
    if (!verdict.valid) throw new ContractViolation(description, productErrorsText(verdict.errors, 'body'));
    return verdict.value;
  };
};

export const checkSession = guard<SessionView>(RUN_API_SCHEMAS.SessionView);
export const checkRun = guard<RunView>(RUN_API_SCHEMAS.RunView);
export const checkApproval = guard<ApprovalView>(RUN_API_SCHEMAS.ApprovalView);
export const checkTrust = guard<TrustView>(RUN_API_SCHEMAS.TrustView);
export const checkTrustItems = guard<TrustItemsView>(RUN_API_SCHEMAS.TrustItemsResponse);
export const checkErrorBody = guard<ErrorBody>(RUN_API_SCHEMAS.ErrorBody);
export const checkHealth = guard<RunHealth>(RUN_API_SCHEMAS.Health);
export const checkRunEvent = guard<PublicStreamEvent>(RUN_API_SCHEMAS.PublicRunEvent);
export const checkTrace = guard<RunTraceView>(RUN_API_SCHEMAS.RunTrace);
export const checkSkills = guard<SkillsResponse>(RUN_API_SCHEMAS.SkillsResponse);
export const checkAgents = guard<AgentsResponse>(RUN_API_SCHEMAS.AgentsResponse);
export const checkJobs = guard<JobsResponse>(RUN_API_SCHEMAS.JobsResponse);
export const checkElicitation = guard<ElicitationView>(RUN_API_SCHEMAS.ElicitationView);
export const checkMcpServers = guard<{ servers: McpServerView[] }>(RUN_API_SCHEMAS.McpServersResponse);
export const checkMcpAuthorization = guard<McpAuthorizationView>(RUN_API_SCHEMAS.McpAuthorizationView);
export const checkMemories = guard<MemoriesResponse>(RUN_API_SCHEMAS.MemoriesResponse);
export const checkMemory = guard<MemoryResponse>(RUN_API_SCHEMAS.MemoryResponse);
export const checkReflection = guard<ReflectionResponse>(RUN_API_SCHEMAS.ReflectionResponse);
export const checkPromoted = guard<PromoteMemoryResponse>(RUN_API_SCHEMAS.PromoteMemoryResponse);
export const checkRuleAdd = guard<RuleAddResponse>(RUN_API_SCHEMAS.RuleAddResponse);
export const checkRule = guard<RuleResponse>(RUN_API_SCHEMAS.RuleResponse);
export const checkRules = guard<RulesResponse>(RUN_API_SCHEMAS.RulesResponse);
export const checkPolicyGovernance = guard<PolicyGovernanceResponse>(RUN_API_SCHEMAS.PolicyGovernanceResponse);
export const checkPolicyVerify = guard<PolicyVerifyResponse>(RUN_API_SCHEMAS.PolicyVerifyResponse);
export const checkReportPage = guard<ReportPage>(RUN_API_SCHEMAS.ReportPage);
export const checkReportRecompute = guard<ReportRecomputePage>(RUN_API_SCHEMAS.ReportRecomputePage);

const reportGuard = <T>(name: keyof typeof REPORT_SCHEMAS): ((value: unknown, description: string) => T) => {
  const validate: ProductValidator<T> = defineProductSchema(`report/${name}`, REPORT_SCHEMAS[name]);
  return (value, description) => {
    const verdict = validate(value);
    if (!verdict.valid) throw new ContractViolation(description, productErrorsText(verdict.errors, 'body'));
    return verdict.value;
  };
};

export const checkReviewPage = reportGuard<ReviewPage>('ReviewPage');
export const checkStoreReview = reportGuard<StoreReviewResponse>('StoreReviewResponse');
export const checkReportCost = reportGuard<ReportCostPage>('ReportCostPage');
export const checkTraceContent = reportGuard<TraceContentPage>('TraceContentPage');
export const checkCostReport = guard<CostReportView>(RUN_API_SCHEMAS.CostReport);
export const checkRunAnsweredBy = guard<RunAnsweredByView>(RUN_API_SCHEMAS.RunAnsweredBy);
export const checkRunReflection = guard<RunReflectionView>(RUN_API_SCHEMAS.RunReflection);
export const checkCostBreakdown = guard<CostBreakdownView>(RUN_API_SCHEMAS.CostBreakdown);
export const checkGuidelines = guard<GuidelinesResponse>(RUN_API_SCHEMAS.GuidelinesResponse);
export const checkGuideline = guard<GuidelineResponse>(RUN_API_SCHEMAS.GuidelineResponse);
export const checkContextCharge = guard<ContextChargeResponse>(RUN_API_SCHEMAS.ContextChargeResponse);
export const checkInbox = guard<InboxResponse>(RUN_API_SCHEMAS.InboxResponse);
export const checkInboxAdd = guard<InboxAddResponse>(RUN_API_SCHEMAS.InboxAddResponse);
export const checkInboxWithdraw = guard<InboxWithdrawResponse>(RUN_API_SCHEMAS.InboxWithdrawResponse);
export const checkUserShellPending = guard<UserShellPendingResponse>(RUN_API_SCHEMAS.UserShellPendingResponse);
export const checkUserShellFrame = guard<UserShellFrame>(RUN_API_SCHEMAS.UserShellFrame);
export const checkRunSuccessor = guard<{ successor: RunView | null }>(RUN_API_SCHEMAS.RunSuccessorResponse);
