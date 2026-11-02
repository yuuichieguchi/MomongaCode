import { isGoverningRule as isGoverning, ruleCoversSubject } from '@momonga/policy';
import type { PermissionRule, PermissionSubject } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import type { Bool, Seq } from 'z3-solver';
import type { CommandModel } from './command-model.ts';
import type { PathModel } from './path-model.ts';
import type { Smt } from './smt.ts';

export const SUBJECT_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Bash', 'mcp'] as const;
export type SubjectTool = (typeof SUBJECT_TOOLS)[number];

export type Witness =
  | { kind: 'path'; tool: string; access: 'read' | 'write'; requested: string; resolved: string }
  | { kind: 'command'; command: string; defaultAllow: boolean }
  | { kind: 'mcp'; server: string; tool: string; readOnly: boolean };

export type RuleTerms = { index: number; rule: PermissionRule; position: Bool; incidental: Bool; strict: Bool };

export type Outcome = {
  deny: Bool;
  ask: Bool;
  allow: Bool;
  allowedByRule: Bool;
  allowedByDefault: Bool;
  byDefault: Bool;
  guarded: Bool;
  asked: Bool;
  incidentalAsk: Bool;
  viaPaths: Bool;
  undecidedByDenyOrAsk: Bool;
};

export type SubjectModel = {
  tool: SubjectTool;
  kind: 'path' | 'command' | 'mcp';
  domain: readonly Bool[];
  terms: readonly RuleTerms[];
  guard: Bool;
  planDeny: Bool;
  dynamicAsk: Bool;
  defaultAllow: Bool;
  witness(read: (term: Seq) => string, readBool: (term: Bool) => boolean): Witness;
  bind(witness: Witness): readonly Bool[];
  exclusion?(witness: Witness): Bool | undefined;
  resolvedTerm: Seq | undefined;
  commandTerm: Seq | undefined;
};

export type DecisionModels = { smt: Smt; paths: PathModel; commands: CommandModel; rules: readonly PermissionRule[]; mode: PermissionMode };

const READ_TOOLS: ReadonlySet<SubjectTool> = new Set(['Read', 'Glob', 'Grep']);
const MCP_PREFIX = 'mcp__';
const MCP_SEPARATOR = '__';

const subjectStub = (tool: SubjectTool): PermissionSubject => {
  if (tool === 'Bash') return { kind: 'command', tool: 'Bash', command: '' };
  if (tool === 'mcp') return { kind: 'mcp', server: 's', tool: 't' };
  return { kind: 'path', tool, paths: [], access: READ_TOOLS.has(tool) ? 'read' : 'write' };
};

const DYNAMIC_READ = (smt: Smt) =>
  smt.concat(smt.text('cat $('), smt.plus(smt.chars([[0x20, 0x20], [0x2f, 0x2f], [0x61, 0x7a]])), smt.text(')'));

const anyOf = (smt: Smt, terms: readonly Bool[]): Bool => (terms.length === 0 ? smt.ctx.Bool.val(false) : terms.length === 1 ? (terms[0] as Bool) : smt.ctx.Or(...terms));

export const createSubject = (models: DecisionModels, tool: SubjectTool, name: string): SubjectModel => {
  const { smt, paths, commands, rules, mode } = models;
  const ctx = smt.ctx;
  const yes = ctx.Bool.val(true);
  const no = ctx.Bool.val(false);
  const stub = subjectStub(tool);
  const bypass = mode === 'bypassPermissions';

  if (tool === 'Bash') {
    const command = commands.variable(`${name}_command`);
    const defaultAllowTerm = ctx.Bool.const(`${name}_default_allow`);
    const terms = rules.flatMap((rule, index): RuleTerms[] =>
      ruleCoversSubject(rule, stub) ? [{ index, rule, position: commands.position(command, rule), incidental: commands.incidental(command, rule), strict: commands.strict(command, rule) }] : [],
    );
    const readsGoverned = rules.some((rule) => isGoverning(rule) && ruleCoversSubject(rule, subjectStub('Read')));
    const dynamicRead = readsGoverned ? smt.member(command, DYNAMIC_READ(smt)) : no;
    return {
      tool,
      kind: 'command',
      domain: [readsGoverned ? ctx.Or(commands.domain(command), dynamicRead) : commands.domain(command)],
      terms,
      guard: no,
      planDeny: no,
      dynamicAsk: dynamicRead,
      defaultAllow: bypass ? yes : defaultAllowTerm,
      witness: (read, readBool) => ({ kind: 'command', command: read(command), defaultAllow: readBool(defaultAllowTerm) }),
      bind: (witness) => (witness.kind === 'command' ? [command.eq(smt.stringValue(witness.command))] : []),
      exclusion: (witness) => (witness.kind === 'command' ? commands.excludedBlock(command, witness.command) : undefined),
      resolvedTerm: undefined,
      commandTerm: command,
    };
  }

  if (tool === 'mcp') {
    const serverChars = smt.chars([[0x2d, 0x2d], [0x30, 0x39], [0x41, 0x5a], [0x61, 0x7a]]);
    const server = smt.concat(smt.plus(serverChars), smt.star(smt.concat(smt.text('_'), smt.plus(serverChars))));
    const toolName = smt.plus(smt.chars([[0x2d, 0x2d], [0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]]));
    const full = smt.stringVariable(`${name}_mcp_name`);
    const readOnly = ctx.Bool.const(`${name}_mcp_read_only`);
    const terms = rules.flatMap((rule, index): RuleTerms[] => {
      if (!rule.tool.startsWith(MCP_PREFIX)) return [];
      const serverLevel = !rule.tool.slice(MCP_PREFIX.length).includes(MCP_SEPARATOR);
      const language = serverLevel ? smt.concat(smt.text(`${rule.tool}${MCP_SEPARATOR}`), smt.anyString) : smt.text(rule.tool);
      const match = smt.member(full, language);
      return [{ index, rule, position: match, incidental: no, strict: match }];
    });
    return {
      tool,
      kind: 'mcp',
      domain: [smt.member(full, smt.concat(smt.text(MCP_PREFIX), server, smt.text(MCP_SEPARATOR), toolName))],
      terms,
      guard: no,
      planDeny: mode === 'plan' ? ctx.Not(readOnly) : no,
      dynamicAsk: no,
      defaultAllow: bypass ? yes : no,
      witness: (read, readBool) => {
        const text = read(full).slice(MCP_PREFIX.length);
        const cut = text.indexOf(MCP_SEPARATOR);
        return { kind: 'mcp', server: text.slice(0, cut), tool: text.slice(cut + MCP_SEPARATOR.length), readOnly: readBool(readOnly) };
      },
      bind: (witness) =>
        witness.kind === 'mcp'
          ? [full.eq(smt.stringValue(`${MCP_PREFIX}${witness.server}${MCP_SEPARATOR}${witness.tool}`)), readOnly.eq(ctx.Bool.val(witness.readOnly))]
          : [],
      resolvedTerm: undefined,
      commandTerm: undefined,
    };
  }

  const access = READ_TOOLS.has(tool) ? 'read' : 'write';
  const vars = paths.variables(name);
  const terms = rules.flatMap((rule, index): RuleTerms[] => {
    if (!ruleCoversSubject(rule, stub)) return [];
    const match = rule.specifier === undefined ? yes : paths.ruleMatches(vars, index);
    return [{ index, rule, position: match, incidental: no, strict: match }];
  });
  const inside = paths.inside(vars.resolved);
  return {
    tool,
    kind: 'path',
    domain: vars.domain,
    terms,
    guard: access === 'write' ? paths.protectedWrite(vars.resolved) : no,
    planDeny: mode === 'plan' && access === 'write' ? yes : no,
    dynamicAsk: no,
    defaultAllow: bypass ? yes : access === 'read' ? inside : mode === 'acceptEdits' ? inside : no,
    witness: (read) => ({ kind: 'path', tool, access, requested: read(vars.requested), resolved: read(vars.resolved) }),
    bind: (witness) => (witness.kind === 'path' ? [vars.requested.eq(smt.stringValue(witness.requested)), vars.resolved.eq(smt.stringValue(witness.resolved))] : []),
    resolvedTerm: vars.resolved,
    commandTerm: undefined,
  };
};

export const ruleEffectCases = (models: DecisionModels, subject: SubjectModel, term: RuleTerms): Bool[] => {
  const { smt, mode } = models;
  const ctx = smt.ctx;
  const bypass = mode === 'bypassPermissions';
  const others = subject.terms.filter((other) => other.index !== term.index);
  const ofEffect = (effect: PermissionRule['effect']): RuleTerms[] => others.filter((other) => other.rule.effect === effect);
  const denyPosition = anyOf(smt, ofEffect('deny').map((other) => other.position));
  const denyIncidental = anyOf(smt, ofEffect('deny').map((other) => ctx.And(ctx.Not(other.position), other.incidental)));
  const askMatch = anyOf(smt, ofEffect('ask').map((other) => ctx.Or(other.position, other.incidental)));
  const governingAskMatch = anyOf(smt, ofEffect('ask').filter((other) => isGoverning(other.rule)).map((other) => ctx.Or(other.position, other.incidental)));
  const allowMatch = anyOf(smt, ofEffect('allow').map((other) => other.strict));
  const noDenyOrPlan = ctx.And(ctx.Not(bypass ? ctx.Or(denyPosition, denyIncidental) : denyPosition), ctx.Not(subject.planDeny));
  const unguarded = ctx.And(noDenyOrPlan, ctx.Not(subject.guard), ctx.Not(subject.dynamicAsk));
  switch (term.rule.effect) {
    case 'allow':
      return [ctx.And(term.strict, unguarded, ctx.Not(askMatch), ctx.Not(denyIncidental), ctx.Not(allowMatch), ctx.Not(subject.defaultAllow))];
    case 'deny': {
      const decisive = ctx.And(term.position, noDenyOrPlan);
      if (bypass) return [decisive, ctx.And(ctx.Not(term.position), term.incidental, noDenyOrPlan)];
      const incidentalOnly = ctx.And(ctx.Not(term.position), term.incidental, unguarded, ctx.Not(askMatch), ctx.Not(denyIncidental), ctx.Or(allowMatch, subject.defaultAllow));
      return [decisive, incidentalOnly];
    }
    case 'ask':
      if (bypass) return isGoverning(term.rule) ? [ctx.And(ctx.Or(term.position, term.incidental), unguarded, ctx.Not(governingAskMatch))] : [];
      return [ctx.And(ctx.Or(term.position, term.incidental), unguarded, ctx.Not(askMatch), ctx.Not(denyIncidental), ctx.Or(allowMatch, subject.defaultAllow))];
  }
};

export const outcomeOf = (models: DecisionModels, subject: SubjectModel, excluded: ReadonlySet<number> = new Set()): Outcome => {
  const { smt, mode } = models;
  const ctx = smt.ctx;
  const bypass = mode === 'bypassPermissions';
  const live = subject.terms.filter((term) => !excluded.has(term.index));
  const ofEffect = (effect: PermissionRule['effect']): RuleTerms[] => live.filter((term) => term.rule.effect === effect);

  const denyPosition = anyOf(smt, ofEffect('deny').map((term) => term.position));
  const denyIncidental = anyOf(smt, ofEffect('deny').map((term) => ctx.And(ctx.Not(term.position), term.incidental)));
  const askMatch = anyOf(smt, ofEffect('ask').map((term) => ctx.Or(term.position, term.incidental)));
  const governingAskMatch = anyOf(smt, ofEffect('ask').filter((term) => isGoverning(term.rule)).map((term) => ctx.Or(term.position, term.incidental)));
  const allowMatch = anyOf(smt, ofEffect('allow').map((term) => term.strict));

  const denied = bypass ? ctx.Or(denyPosition, denyIncidental) : denyPosition;
  const deny = ctx.Or(denied, subject.planDeny);
  const open = ctx.Not(deny);
  const guarded = ctx.And(open, subject.guard);
  const afterGuard = ctx.And(open, ctx.Not(subject.guard));
  const asked = ctx.And(afterGuard, askMatch);
  const afterAsk = ctx.And(afterGuard, ctx.Not(askMatch));
  const incidentalAsk = ctx.And(afterAsk, denyIncidental);
  const afterIncidental = ctx.And(afterAsk, ctx.Not(denyIncidental));
  const allowedByRule = ctx.And(afterIncidental, allowMatch);
  const allowedByDefault = ctx.And(afterIncidental, ctx.Not(allowMatch), subject.defaultAllow);
  const askedByDefault = ctx.And(afterIncidental, ctx.Not(allowMatch), ctx.Not(subject.defaultAllow));
  const askOverridden = bypass ? ctx.And(asked, ctx.Not(governingAskMatch)) : ctx.Bool.val(false);
  const askHeld = bypass ? ctx.And(asked, governingAskMatch) : asked;
  const dynamicAsk = ctx.And(open, subject.dynamicAsk);
  const allow = ctx.And(ctx.Or(allowedByRule, allowedByDefault, askOverridden), ctx.Not(dynamicAsk));
  const ask = ctx.Or(guarded, askHeld, incidentalAsk, askedByDefault, dynamicAsk);
  return {
    deny,
    ask,
    allow,
    allowedByRule,
    allowedByDefault,
    byDefault: ctx.And(ctx.Or(allowedByDefault, askedByDefault), ctx.Not(dynamicAsk)),
    guarded,
    asked,
    incidentalAsk,
    viaPaths: dynamicAsk,
    undecidedByDenyOrAsk: afterIncidental,
  };
};
