export const AUTO_MODE_UNAVAILABLE = {
  code: 'mode_unavailable',
  message: 'auto mode needs a classifier model alias: set autoMode.classifier in the user settings',
} as const;

export const CLASSIFIER_VERDICTS = ['safe', 'unsafe'] as const;
export const CLASSIFIER_CONFIDENCES = ['high', 'medium', 'low'] as const;

export type ClassifierVerdict = {
  verdict: (typeof CLASSIFIER_VERDICTS)[number];
  confidence: (typeof CLASSIFIER_CONFIDENCES)[number];
  rationale: string;
};

export const CLASSIFIER_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...CLASSIFIER_VERDICTS] },
    confidence: { type: 'string', enum: [...CLASSIFIER_CONFIDENCES] },
    rationale: { type: 'string' },
  },
  required: ['verdict', 'confidence', 'rationale'],
  additionalProperties: false,
} as const;

export const classifierAllows = (verdict: ClassifierVerdict): boolean => verdict.verdict === 'safe' && verdict.confidence === 'high';

export const parseClassifierVerdict = (text: string): ClassifierVerdict | { error: string } => {
  let value: unknown;
  try {
    value = JSON.parse(text);
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
