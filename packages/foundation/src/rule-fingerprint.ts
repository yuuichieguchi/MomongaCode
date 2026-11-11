import { canonicalJson, sha256Hex } from './canonical-json.ts';

export const RULE_VERDICT_DEFINITION = 5;

export type VerdictSubject = {
  readonly rules: readonly unknown[];
  readonly roots: readonly string[];
  readonly mode: string;
  readonly home: string;
  readonly cwd: string;
  readonly exemptDirectory: string | null;
  readonly enforcement: unknown;
  readonly protectedSet: unknown;
  readonly secretLocations: readonly unknown[];
  readonly deniedLocations: readonly unknown[];
};

export const verdictSubjectOf = <Subject extends VerdictSubject>({
  rules,
  roots,
  mode,
  home,
  cwd,
  exemptDirectory,
  enforcement,
  protectedSet,
  secretLocations,
  deniedLocations,
}: Subject): Pick<Subject, keyof VerdictSubject> => ({ rules, roots: [...new Set(roots)], mode, home, cwd, exemptDirectory, enforcement, protectedSet, secretLocations, deniedLocations });

export const verdictKey = (subject: VerdictSubject, solver: string): string => sha256Hex(canonicalJson({ subject, solver, verdictDefinition: RULE_VERDICT_DEFINITION }));
