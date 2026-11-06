export const QUALITY_METRICS = [
  { name: 'continuationRate', direction: 'higher' },
  { name: 'governanceFidelity', direction: 'higher' },
  { name: 'governanceConsistency', direction: 'higher' },
  { name: 'governanceMinimality', direction: 'higher' },
  { name: 'memoryStaleRate', direction: 'lower' },
  { name: 'retrievalPrecision', direction: 'higher' },
  { name: 'retrievalRecall', direction: 'higher' },
] as const;

export type QualityMetric = (typeof QUALITY_METRICS)[number];
export type QualityMetricName = QualityMetric['name'];

export type QualityCell = { numerator: number; denominator: number };

export type QualityCells = Record<QualityMetricName, QualityCell>;
