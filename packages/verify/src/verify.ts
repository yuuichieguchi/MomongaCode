import { systemClock } from '@momonga/foundation';
import type { Clock, ProtectedSet, RuleEnforcement } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import type { PermissionRule, PolicyHostFilesystem } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { startBudget } from './budget.ts';
import { alphabetFor } from './char-set.ts';
import { createCommandModel } from './command-model.ts';
import { createPathModel } from './path-model.ts';
import { checkBashAdmission, checkDenyPrecedence, checkRuleConsistency, checkSecretReach } from './properties.ts';
import type { SecretLocation } from './properties.ts';
import { buildSubjects } from './queries.ts';
import type { QueryContext } from './queries.ts';
import { exitCodeOf } from './report.ts';
import type { PropertyResult, VerificationReport } from './report.ts';
import { createSmt } from './smt.ts';
import type { Z3Api } from './smt.ts';

export type VerifyRequest = {
  rules: readonly PermissionRule[];
  roots: readonly string[];
  mode: PermissionMode;
  home: string;
  cwd: string;
  protectedSet: ProtectedSet;
  fs: PolicyHostFilesystem;
  secretLocations: readonly SecretLocation[];
  exemptDirectory: string | null;
  enforcement: RuleEnforcement;
  budgetMs: number;
  clock?: Clock;
};

const STATIC_OUTSIDE_PROOF: readonly string[] = [
  'What an arbitrary shell command does when it runs. Only the rules are checked; a Bash rule is checked against plain commands, that is one program followed by unquoted literal words.',
  'A Bash(...) allow rule matches the command text literally, so it allows every option of its program, including options that make the program run another program, such as git -c core.pager=<program> log under Bash(git:*), find . -exec <program> {} \\; under Bash(find:*), or npm test --script-shell=<program> under Bash(npm test:*). What those options do is not checked.',
  'Commands with quoting, expansion, redirects, pipes, && or ;, wrapper programs (env, sudo, timeout, xargs and the like), shell payloads (bash -c) and script interpreters, and the file paths the product derives from the arguments of a command.',
  'Path normalisation: the model takes absolute, normalised paths whose symlinks are those the rules were compiled against. Relative paths, .. segments, other symlinks and non-NFC names are normalised by product code that is not proved.',
  'Path characters: printable ASCII plus the non-ASCII characters that occur in the rules, the home folder and the roots. Case folding covers upper and lower case pairs only.',
  'Hooks, the auto-mode classifier (auto mode is checked as manual mode), the sandbox profile, approvals granted while a run is in progress, the scratch folder that each session exempts from file rules, and agent skill directories that are readable by default.',
  'MCP server names that contain a double underscore, and whether an MCP tool is read-only, which the model leaves open.',
  'The solver and the encoding. The encoding is replayed against the real decision code for every counterexample and compared on generated inputs by the test suite; a proved result is not replayed.',
];

const unmodelledNotes = (context: QueryContext, rules: readonly PermissionRule[]): string[] => {
  const notes: string[] = [];
  const covered = new Set<number>();
  for (const subject of context.subjects.values()) for (const term of subject.terms) covered.add(term.index);
  const withoutSubject = rules.filter((_rule, index) => !covered.has(index));
  if (withoutSubject.length > 0) notes.push(`Rules for tools the model has no subject for, which are not checked: ${withoutSubject.map((rule) => rule.text).join(', ')}.`);
  const unmodelled = rules.filter((rule) => rule.tool === 'Bash' && context.models.commands.unmodelled(rule));
  if (unmodelled.length > 0) {
    notes.push(
      `Bash rules the model cannot follow, because a word uses a character outside the modelled command alphabet or an allow rule names a wrapper, shell or eval program such as sudo, env or bash. They are treated as matching no modelled command. A deny rule whose words are expressible and whose program is a wrapper, shell or eval program is checked for rule-consistency on a few concrete commands against the real decision code, and a one-word rule of that kind does not affect bash-admission. Every other such rule makes rule-consistency unknown; an allow rule makes bash-admission unknown while a Bash deny rule exists, and a deny or ask rule makes it unknown while a Bash allow rule exists, because the product can decide a command differently from the model: ${unmodelled.map((rule) => rule.text).join(', ')}.`,
    );
  }
  return notes;
};

export const buildQueryContext = (api: Z3Api, request: VerifyRequest): QueryContext => {
  const { rules, roots, mode, home, cwd, protectedSet, fs, secretLocations, exemptDirectory, enforcement, budgetMs } = request;
  const budget = startBudget(request.clock ?? systemClock, budgetMs);
  const fileRules = computeFileRules(rules, roots, exemptDirectory, enforcement, fs.canonicalise, fs.volumeProbe);
  const alphabet = alphabetFor([
    home,
    cwd,
    ...roots,
    ...rules.map((rule) => rule.specifier ?? ''),
    ...rules.flatMap((rule) => rule.exceptions ?? []),
    ...secretLocations.flatMap((location) => {
      const canonical = fs.canonicalise(location.directory);
      return canonical.ok ? [location.directory, canonical.path] : [location.directory];
    }),
    ...protectedSet.paths,
    ...protectedSet.lexicalPaths,
    ...protectedSet.literals,
    ...fileRules.entries.flatMap((entry) => [entry.anchorDirectory, entry.lexicalDirectory]),
  ]);
  const smt = createSmt(api, alphabet);
  const paths = createPathModel({ smt, fileRules, protectedSet, roots, probes: fs });
  const commands = createCommandModel(smt);
  const models = { smt, paths, commands, rules, mode };
  return {
    models,
    env: { rules, roots, mode, home, cwd, fileRules, protectedSet, fs, globBudgetMs: budgetMs },
    budget,
    subjects: buildSubjects(models),
    mismatches: [],
  };
};

export const verifyPermissions = async (api: Z3Api, request: VerifyRequest): Promise<VerificationReport> => {
  const { rules, mode, secretLocations } = request;
  const context = buildQueryContext(api, request);
  const { mismatches } = context;
  const checks = [
    (scoped: QueryContext) => checkDenyPrecedence(scoped),
    (scoped: QueryContext) => checkSecretReach(scoped, secretLocations),
    (scoped: QueryContext) => checkRuleConsistency(scoped),
    (scoped: QueryContext) => checkBashAdmission(scoped),
  ];
  const results: PropertyResult[] = [];
  for (const [index, check] of checks.entries()) {
    results.push(await check({ ...context, budget: context.budget.share(checks.length - index) }));
  }
  return {
    mode,
    ruleCount: rules.length,
    solver: `Z3 ${api.getVersionString()}`,
    results,
    mismatches,
    outsideProof: [...STATIC_OUTSIDE_PROOF, ...unmodelledNotes(context, rules)],
    exitCode: exitCodeOf(results, mismatches),
  };
};
