export type Measuring = { fields: readonly string[]; step: string | null; elapsedSeconds: number; declaration: string };

export type MeasuringWire = { fields: string[]; step: string | null; elapsed_seconds: number; declaration: string };

export const measuringWireOf = (measuring: Measuring): MeasuringWire => ({
  fields: [...measuring.fields],
  step: measuring.step,
  elapsed_seconds: measuring.elapsedSeconds,
  declaration: measuring.declaration,
});

const isCountOfSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isFieldList = (value: unknown): value is string[] => Array.isArray(value) && value.every((field) => typeof field === 'string');

export const measuringOfWire = (value: unknown): Measuring | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { fields, step, elapsed_seconds: elapsedSeconds, declaration } = value as Record<string, unknown>;
  if (!isFieldList(fields) || !(step === null || typeof step === 'string') || !isCountOfSeconds(elapsedSeconds) || typeof declaration !== 'string') return undefined;
  return { fields, step, elapsedSeconds, declaration };
};

export const isMeasuring = (value: unknown): value is Measuring => {
  if (typeof value !== 'object' || value === null) return false;
  const { fields, step, elapsedSeconds, declaration } = value as Record<string, unknown>;
  return isFieldList(fields) && (step === null || typeof step === 'string') && isCountOfSeconds(elapsedSeconds) && typeof declaration === 'string';
};

export const measuringStepOf = (measuring: Measuring): string => {
  const step = measuring.step === null ? 'starting' : `step "${measuring.step}"`;
  return `measuring ${measuring.fields.join(', ')} of this model, ${step}`;
};

export const measuringSkipOf = (measuring: Measuring): string => `to skip it, ${measuring.declaration}`;

export const measuringLineOf = (measuring: Measuring): string => `${measuringStepOf(measuring)}; ${measuringSkipOf(measuring)}`;
