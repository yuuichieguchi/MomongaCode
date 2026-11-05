import { parseOutsideJson } from '@momonga/foundation';
import { CLASSIFIER_CONFIDENCES, CLASSIFIER_VERDICTS } from '@momonga/protocol';
import type { ClassifierVerdict } from '@momonga/protocol';

export const parseClassifierVerdict = (text: string): ClassifierVerdict | { error: string } => {
  let value: unknown;
  try {
    value = parseOutsideJson(text);
  } catch (error) {
    return { error: `the classifier reply is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'the classifier reply is not a JSON object' };
  const record = value as Record<string, unknown>;
  const verdict = CLASSIFIER_VERDICTS.find((candidate) => candidate === record['verdict']);
  const confidence = CLASSIFIER_CONFIDENCES.find((candidate) => candidate === record['confidence']);
  const rationale = record['rationale'];
  if (verdict === undefined) return { error: 'the classifier reply has no valid verdict' };
  if (confidence === undefined) return { error: 'the classifier reply has no valid confidence' };
  if (typeof rationale !== 'string') return { error: 'the classifier reply has no rationale' };
  return { verdict, confidence, rationale };
};
