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
