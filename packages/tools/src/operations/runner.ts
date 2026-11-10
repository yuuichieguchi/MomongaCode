import { foldedKey, wildcardMatches } from '@momonga/policy';
import type { PermissionSubject } from '@momonga/policy';
import { ToolExecutionError, defineTool } from '../types.ts';
import type { AnyTool, GateCall, GateFacts, ReconcileContext, ReconcileResult, SubjectContext, ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import type { ToolIdempotencyRecord } from '../ports.ts';
import type { ForgeAccess } from '../forge/instances.ts';
import { parseRemoteUrl } from '../forge/remote.ts';
import { readOnlyEnvironment } from '../read-only-call.ts';
import { resolveDestinations, sameList } from './git-read.ts';
import type { GitReader } from './git-read.ts';
import type { ArgvRunner, RenderedNetwork } from './argv.ts';
import { OPERATION_SPECS } from './catalogue.ts';
import { describeClause, evaluateClauses, failedClauses } from './spec.ts';
import type { ArgvCall, ArgvItem, ForgeCall, Network, OperationSpec, Probe } from './spec.ts';
import { isTruthy, lookup, renderTemplate } from './template.ts';
import type { Scope } from './template.ts';

export type OperationSettings = { readonly protectedRefs?: readonly string[]; readonly approval?: Readonly<Record<string, 'rule' | 'always'>> };

export type OperationDeps = { runArgv: ArgvRunner; readGit: GitReader; forge: ForgeAccess; settings: OperationSettings };

type Observation = Record<string, unknown>;

const DEFAULT_REMOTE = 'origin';
const STDERR_LIMIT = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const PUSH_URLS = 'pushUrls';

const callOf = (idemKey: string, destination?: string): Record<string, string> => ({ key: idemKey, ...(destination === undefined ? {} : { destination }) });

const remoteEnvironment = (env: Readonly<Record<string, string>>): Record<string, string> => ({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' });

const FORGE_REMOTE = 'forgeRemote';

const renderArgv = (items: readonly ArgvItem[], scope: Scope): string[] =>
  items.flatMap((item) => {
    if (typeof item === 'string') return [renderTemplate(item, scope)];
    const chosen = isTruthy(scope, item.if) ? item.then : (item.else ?? []);
    return chosen.map((entry) => renderTemplate(entry, scope));
  });

const recordedPushUrls = (scope: Scope): string[] => {
  const before = scope['before'];
  const urls = isRecord(before) ? before[PUSH_URLS] : scope[PUSH_URLS];
  return stringList(urls) ?? [];
};

const renderNetwork = (network: Network | undefined, scope: Scope): RenderedNetwork => {
  if (network === undefined || network === 'none') return 'none';
  if (network === 'destinations') return { destinations: recordedPushUrls(scope) };
  const destination = lookup(scope, 'call.destination');
  return { destinations: destination === undefined ? [] : [destination] };
};

const stringList = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : undefined);

const renderArgs = (args: Readonly<Record<string, string>>, scope: Scope): Record<string, string> =>
  Object.fromEntries(Object.entries(args).map(([key, template]) => [key, renderTemplate(template, scope)]));

const settingOf = (settings: OperationSettings, name: string): { approval?: 'rule' | 'always' } => {
  const approval = settings.approval?.[name];
  return approval === undefined ? {} : { approval };
};

const protectedRefsOf = (settings: OperationSettings): readonly string[] => settings.protectedRefs ?? [];

const flatten = (observation: Observation, prefix = ''): string[] =>
  Object.entries(observation).flatMap(([key, value]) => {
    if (isRecord(value)) return flatten(value, `${prefix}${key}.`);
    if (Array.isArray(value)) return [`${prefix}${key}=${JSON.stringify(value)}`];
    return [`${prefix}${key}=${typeof value === 'string' ? JSON.stringify(value) : 'not observed'}`];
  });

type Runtime = { spec: OperationSpec; deps: OperationDeps };

const usesForge = (spec: OperationSpec): boolean =>
  spec.subject.kind === 'forge' || spec.observe.some((probe) => 'forge' in probe.via) || (spec.effect !== undefined && 'forge' in spec.effect);

const resolveForgeRemote = async (runtime: Runtime, ctx: SubjectContext, call: GateCall): Promise<string> => {
  const { fetch } = await resolveDestinations(runtime.deps.readGit, DEFAULT_REMOTE, { cwd: ctx.workingDirectory, env: call.env, signal: call.signal });
  const first = fetch[0];
  if (first === undefined) throw new ToolExecutionError(`the repository has no remote named ${DEFAULT_REMOTE}`);
  return first;
};

const forgeRemoteOf = (scope: Scope): string => {
  const remote = scope[FORGE_REMOTE];
  if (typeof remote !== 'string') throw new ToolExecutionError('the forge of this repository was not resolved before the call');
  return remote;
};

const extractOf = (stdout: string, mode: 'trim' | 'firstField' | undefined): string => {
  const text = stdout.trim();
  return mode === 'firstField' ? (text.split(/\s+/)[0] ?? '') : text;
};

const observeArgv = async (runtime: Runtime, via: Extract<Probe['via'], { argv: unknown }>, ctx: ReconcileContext, scope: Scope): Promise<string | undefined> => {
  const network = renderNetwork(via.network, scope);
  const result = await runtime.deps.runArgv(renderArgv(via.argv, scope), {
    cwd: ctx.session.cwd,
    env: network === 'none' ? readOnlyEnvironment(ctx.env) : remoteEnvironment(ctx.env),
    signal: ctx.signal,
    network,
    context: ctx,
    effect: false,
  });
  if (result.exitCode !== 0) return via.emptyOnFailure === true ? '' : undefined;
  return extractOf(result.stdout, via.extract);
};

const AGREEMENT_LOST = 'mixed';

const observeEach = async (runtime: Runtime, via: Extract<Probe['via'], { argv: unknown }>, ctx: ReconcileContext, scope: Scope): Promise<string | undefined> => {
  const urls = recordedPushUrls(scope);
  if (urls.length === 0) throw new ToolExecutionError(`${runtime.spec.name} observes each push destination but none is recorded`);
  const values: Array<string | undefined> = [];
  for (const url of urls) {
    const input = scope['input'];
    values.push(await observeArgv(runtime, via, ctx, { ...scope, input, call: callOf(ctx.idemKey, url) }));
  }
  if (values.some((value) => value === undefined)) return undefined;
  return new Set(values).size === 1 ? (values[0] as string) : AGREEMENT_LOST;
};

const observeProbe = async (runtime: Runtime, probe: Probe, ctx: ReconcileContext, scope: Scope): Promise<unknown> => {
  const via = probe.via;
  if ('argv' in via) return via.each === undefined ? observeArgv(runtime, via, ctx, scope) : observeEach(runtime, via, ctx, scope);
  const answer = await runtime.deps.forge.request({
    remoteUrl: forgeRemoteOf(scope),
    operation: via.forge,
    args: renderArgs(via.args, scope),
    signal: ctx.signal,
    boundMs: Math.max(0, ctx.deadlineAt - ctx.clock.now()),
  });
  if (via.shape === 'one') return { ...answer.fields };
  if (via.shape === 'list') return { count: String(answer.items.length), ...(answer.items[0] ?? {}) };
  const contains = via.contains;
  if (contains === undefined) throw new ToolExecutionError(`${runtime.spec.name} counts without a contains filter`);
  const needle = renderTemplate(contains.value, scope);
  return String(answer.items.filter((item) => item[contains.field]?.includes(needle) === true).length);
};

const remoteNameOf = (runtime: Runtime, input: Record<string, unknown>): string | undefined => {
  const subject = runtime.spec.subject;
  return subject.kind === 'repo' && subject.remote !== undefined ? renderTemplate(subject.remote, { input }) : undefined;
};

const destinationsOf = async (runtime: Runtime, input: Record<string, unknown>, ctx: SubjectContext, call: GateCall): Promise<string[] | undefined> => {
  const remote = remoteNameOf(runtime, input);
  return remote === undefined ? undefined : (await resolveDestinations(runtime.deps.readGit, remote, { cwd: ctx.workingDirectory, env: call.env, signal: call.signal })).push;
};

const GATE_PUSH = 'pushUrls';
const GATE_FETCH = 'fetchUrls';

const gateFactsOf = async (runtime: Runtime, input: Record<string, unknown>, ctx: SubjectContext, call: GateCall): Promise<GateFacts> => {
  const forge = usesForge(runtime.spec) ? { [FORGE_REMOTE]: await resolveForgeRemote(runtime, ctx, call) } : {};
  const remote = remoteNameOf(runtime, input);
  if (remote === undefined) return forge;
  const destinations = await resolveDestinations(runtime.deps.readGit, remote, { cwd: ctx.workingDirectory, env: call.env, signal: call.signal });
  return { ...forge, [GATE_PUSH]: destinations.push, [GATE_FETCH]: destinations.fetch };
};

type Recorded = { forgeRemote?: string | undefined };

const observe = async (runtime: Runtime, ctx: ReconcileContext, input: Record<string, unknown>, before: Observation | undefined, recorded: Recorded, destinations?: string[]): Promise<Observation> => {
  const observed: Observation = {};
  if (destinations !== undefined) observed[PUSH_URLS] = destinations;
  for (const probe of runtime.spec.observe) {
    const scope: Scope = {
      input,
      call: callOf(ctx.idemKey),
      ...(before === undefined ? {} : { before }),
      ...(destinations === undefined ? {} : { [PUSH_URLS]: destinations }),
      ...(recorded.forgeRemote === undefined ? {} : { [FORGE_REMOTE]: recorded.forgeRemote }),
    };
    const value = await observeProbe(runtime, probe, ctx, scope);
    if (value !== undefined) observed[probe.id] = value;
  }
  return observed;
};

const scopeOf = (ctx: ReconcileContext, input: Record<string, unknown>, before: Observation | undefined, after: Observation | undefined, recorded: Recorded = {}): Scope => ({
  input,
  call: callOf(ctx.idemKey),
  ...(recorded.forgeRemote === undefined ? {} : { [FORGE_REMOTE]: recorded.forgeRemote }),
  ...(before === undefined ? {} : { before }),
  ...(after === undefined ? {} : { after }),
});

const targetOf = (runtime: Runtime, scope: Scope): string => {
  const subject = runtime.spec.subject;
  if (subject.kind === 'repo') return subject.refs?.map((ref) => renderTemplate(ref, scope)).join(',') ?? runtime.spec.name;
  if (subject.kind === 'forge' && subject.pr !== undefined) return `#${renderTemplate(subject.pr, scope)}`;
  return runtime.spec.name;
};

const reportOf = (runtime: Runtime, scope: Scope): string => renderTemplate(runtime.spec.report, scope);

const recordedOf = (prepared: Record<string, unknown>): Recorded => (typeof prepared[FORGE_REMOTE] === 'string' ? { forgeRemote: prepared[FORGE_REMOTE] } : {});

const readPrepared = (record: ToolIdempotencyRecord): { before: Observation; recorded: Recorded } => {
  const prepared: unknown = record.meta['prepared'];
  if (!isRecord(prepared) || !isRecord(prepared['before'])) throw new ToolExecutionError('the interrupted call has no recorded observation to compare with');
  return { before: prepared['before'], recorded: recordedOf(prepared) };
};

const settledResult = (runtime: Runtime, scope: Scope, outcome: 'applied' | 'already_applied'): ToolResult => ({
  status: 'completed',
  output: reportOf(runtime, scope),
  effect: { operation: runtime.spec.name, target: targetOf(runtime, scope), outcome },
});

const failedResult = (runtime: Runtime, scope: Scope, reason: string, observed: Observation | undefined): ToolResult => ({
  status: 'failed',
  output: `${runtime.spec.name} did not reach its goal: ${reason}${observed === undefined ? '' : `\nObserved after the attempt: ${flatten(observed).join(', ')}`}`,
  effect: { operation: runtime.spec.name, target: targetOf(runtime, scope), outcome: 'failed' },
});

const runEffect = async (runtime: Runtime, effect: ArgvCall | ForgeCall, ctx: ToolContext, scope: Scope): Promise<string | undefined> => {
  if ('argv' in effect) {
    const result = await runtime.deps.runArgv(renderArgv(effect.argv, scope), {
      cwd: ctx.session.cwd,
      env: remoteEnvironment(ctx.env),
      signal: ctx.signal,
      network: renderNetwork(effect.network, scope),
      context: ctx,
      effect: true,
    });
    return result.exitCode === 0 ? undefined : `the command exited with ${result.exitCode}: ${result.stderr.trim().slice(0, STDERR_LIMIT)}`;
  }
  const answer = await runtime.deps.forge.request({
    remoteUrl: forgeRemoteOf(scope),
    operation: effect.forge,
    args: renderArgs(effect.args, scope),
    signal: ctx.signal,
    boundMs: Math.max(0, ctx.deadlineAt - ctx.clock.now()),
  });
  return answer.status === 'success' ? undefined : `the forge answered ${answer.status.replace('_', ' ')}`;
};

const executeOperation = async (runtime: Runtime, input: Record<string, unknown>, ctx: ToolContext, prepared: Record<string, unknown> | undefined): Promise<ToolResult> => {
  const { spec } = runtime;
  const call: GateCall = { signal: ctx.signal, env: ctx.env };
  if (spec.effect === undefined) {
    const located: Recorded = usesForge(spec) ? { forgeRemote: await resolveForgeRemote(runtime, ctx, call) } : {};
    const after = await observe(runtime, ctx, input, undefined, located);
    return { status: 'completed', output: reportOf(runtime, scopeOf(ctx, input, undefined, after)) };
  }
  if (prepared === undefined || !isRecord(prepared['before'])) throw new ToolExecutionError(`${spec.name} was started without a recorded observation`);
  const before = prepared['before'];
  const recorded = recordedOf(prepared);
  const beforeScope = scopeOf(ctx, input, before, before, recorded);
  const approved = before[PUSH_URLS];
  if (Array.isArray(approved)) {
    const current = (await destinationsOf(runtime, input, ctx, call)) ?? [];
    if (!sameList(approved, current)) return failedResult(runtime, beforeScope, `the push destinations changed after the approval, so nothing was sent: approved ${JSON.stringify(approved)}, now ${JSON.stringify(current)}`, undefined);
  }
  const unmet = failedClauses(spec.require, beforeScope);
  if (unmet.length > 0) return failedResult(runtime, beforeScope, `the precondition does not hold, so nothing was sent: ${unmet.map((clause) => describeClause(clause, beforeScope)).join('; ')}`, undefined);
  if (evaluateClauses(spec.applied, beforeScope)) return settledResult(runtime, beforeScope, 'already_applied');
  const effectScope = scopeOf(ctx, input, before, undefined, recorded);
  let effectProblem: string | undefined;
  try {
    effectProblem = await runEffect(runtime, spec.effect, ctx, effectScope);
  } catch (error) {
    effectProblem = error instanceof Error ? error.message : String(error);
  }
  const after = await observe(runtime, ctx, input, before, recorded);
  const afterScope = scopeOf(ctx, input, before, after, recorded);
  if (evaluateClauses(spec.applied, afterScope)) return settledResult(runtime, afterScope, 'applied');
  return failedResult(runtime, afterScope, effectProblem ?? 'the observed state does not match the goal', after);
};

const reconcileOperation = async (runtime: Runtime, input: Record<string, unknown>, record: ToolIdempotencyRecord, ctx: ReconcileContext): Promise<ReconcileResult> => {
  const { spec } = runtime;
  if (record.authorisedAt === undefined) return { outcome: 'not_applied', output: '' };
  const { before, recorded } = readPrepared(record);
  const after = await observe(runtime, ctx, input, before, recorded);
  const scope = scopeOf(ctx, input, before, after, recorded);
  if (evaluateClauses(spec.applied, scope)) return { outcome: 'already_applied', output: reportOf(runtime, scope) };
  if (spec.guard !== 'none' && evaluateClauses(spec.unchanged, scope)) return { outcome: 'not_applied', output: '' };
  const reason = spec.guard === 'none' ? 'the call cannot be repeated safely' : 'the state matches neither the state before nor the goal';
  return {
    outcome: 'unknown',
    output: `${spec.name} was interrupted and its effect is unknown: ${reason}. Observed now: ${flatten(after).join(', ')}. Inspect the real state before trying again.`,
  };
};

const approvedDestinations = async (runtime: Runtime, input: Record<string, unknown>, ctx: ToolContext, gateFacts: Record<string, unknown> | undefined): Promise<string[] | undefined> => {
  const current = await destinationsOf(runtime, input, ctx, { signal: ctx.signal, env: ctx.env });
  if (current === undefined) return undefined;
  const approved = stringList(gateFacts?.[GATE_PUSH]);
  if (approved === undefined) throw new ToolExecutionError(`${runtime.spec.name} was started without the push destinations its permission was decided on`);
  if (!sameList(approved, current)) throw new ToolExecutionError(`the push destinations changed between the permission decision and the start, so nothing was sent: approved ${JSON.stringify(approved)}, now ${JSON.stringify(current)}`);
  return approved;
};

const subjectOf = (runtime: Runtime, input: Record<string, unknown>, gateFacts: Record<string, unknown> | undefined): PermissionSubject => {
  const { spec, deps } = runtime;
  const scope: Scope = { input };
  const setting = settingOf(deps.settings, spec.name);
  const base = setting.approval ?? spec.approval;
  const subject = spec.subject;
  if (subject.kind === 'none') return { kind: 'none', tool: spec.name };
  if (subject.kind === 'repo') {
    const refs = (subject.refs ?? []).map((ref) => renderTemplate(ref, scope));
    const flagged = (subject.alwaysWhen ?? []).some((flag) => isTruthy(scope, `input.${flag}`));
    const protectedHit = refs.some((ref) => protectedRefsOf(deps.settings).some((pattern) => wildcardMatches(foldedKey(pattern), foldedKey(ref))));
    const remote = subject.remote === undefined ? null : renderTemplate(subject.remote, scope);
    const pushUrls = stringList(gateFacts?.[GATE_PUSH]);
    const fetchUrls = stringList(gateFacts?.[GATE_FETCH]);
    if (remote !== null && (pushUrls === undefined || fetchUrls === undefined)) throw new ToolExecutionError(`${spec.name} needs the push destinations of ${remote} resolved before its permission is decided`);
    const destinations = pushUrls === undefined || fetchUrls === undefined ? undefined : { push: pushUrls, fetch: fetchUrls };
    return {
      kind: 'repo',
      tool: spec.name,
      operation: spec.name,
      remote,
      refs,
      destinations: destinations?.push ?? [],
      destinationsMatchFetch: destinations === undefined || sameList(destinations.push, destinations.fetch),
      approval: base === 'always' || flagged || protectedHit ? 'always' : 'rule',
    };
  }
  const forgeRemote = gateFacts?.[FORGE_REMOTE];
  if (typeof forgeRemote !== 'string') throw new ToolExecutionError(`${spec.name} needs the forge of this repository resolved before its permission is decided`);
  const location = parseRemoteUrl(forgeRemote);
  const pr = subject.pr === undefined ? undefined : Number(renderTemplate(subject.pr, scope));
  const headSha = subject.headSha === undefined ? undefined : renderTemplate(subject.headSha, scope);
  return {
    kind: 'forge',
    tool: spec.name,
    operation: spec.name,
    host: location.host,
    repo: location.repo,
    ...(pr === undefined ? {} : { pr }),
    ...(headSha === undefined ? {} : { headSha }),
    approval: base,
  };
};

const toolOf = (spec: OperationSpec, deps: OperationDeps): AnyTool => {
  const runtime: Runtime = { spec, deps };
  const body = {
    name: spec.name,
    description: spec.description,
    kind: spec.kind,
    tier: 'optional' as const,
    inputSchema: spec.input,
    timeoutMs: spec.timeoutMs,
    title: (input: Record<string, unknown>): string => renderTemplate(spec.title, { input }),
    gateFacts: (input: Record<string, unknown>, ctx: SubjectContext, call: GateCall): Promise<GateFacts> => gateFactsOf(runtime, input, ctx, call),
    subject: (input: Record<string, unknown>, _ctx: SubjectContext, gateFacts?: GateFacts): PermissionSubject => subjectOf(runtime, input, gateFacts),
    execute: (input: Record<string, unknown>, ctx: ToolContext, prepared: Record<string, unknown> | undefined): Promise<ToolResult> => executeOperation(runtime, input, ctx, prepared),
  };
  if (spec.sideEffect === 'read_only') {
    return defineTool<Record<string, unknown>>({ ...body, sideEffect: 'read_only' });
  }
  const stateful = {
    ...body,
    sideEffect: spec.sideEffect,
    subjectKind: spec.subject.kind,
    prepare: async (input: Record<string, unknown>, ctx: ToolContext, gateFacts?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const facts = gateFacts ?? (await gateFactsOf(runtime, input, ctx, { signal: ctx.signal, env: ctx.env }));
      const approved = await approvedDestinations(runtime, input, ctx, facts);
      const forgeRemote = typeof facts[FORGE_REMOTE] === 'string' ? facts[FORGE_REMOTE] : undefined;
      const before = await observe(runtime, ctx, input, undefined, { forgeRemote }, approved);
      return { before, observedAt: ctx.clock.now(), ...(forgeRemote === undefined ? {} : { [FORGE_REMOTE]: forgeRemote }) };
    },
    reconcile: (input: Record<string, unknown>, record: ToolIdempotencyRecord, ctx: ReconcileContext): Promise<ReconcileResult> => reconcileOperation(runtime, input, record, ctx),
  };
  return defineTool<Record<string, unknown>>(stateful as unknown as ToolDefinition<Record<string, unknown>>);
};

export const createOperationTools = (deps: OperationDeps): AnyTool[] => OPERATION_SPECS.map((spec) => toolOf(spec, deps));

