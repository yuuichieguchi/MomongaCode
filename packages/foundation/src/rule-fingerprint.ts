import { canonicalJson, sha256Hex } from './canonical-json.ts';

export const ruleFingerprint = (subject: { input: unknown; solverVersion: string }): string => sha256Hex(canonicalJson({ input: subject.input, solverVersion: subject.solverVersion }));
