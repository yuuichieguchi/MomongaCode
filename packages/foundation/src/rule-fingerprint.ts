import { canonicalJson, sha256Hex } from './canonical-json.ts';

export const RULE_VERDICT_DEFINITION = 2;

export const ruleFingerprint = (subject: { input: unknown; solverVersion: string }): string =>
  sha256Hex(canonicalJson({ input: subject.input, solverVersion: subject.solverVersion, verdictDefinition: RULE_VERDICT_DEFINITION }));
