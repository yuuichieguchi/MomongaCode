const stringField = (error: object, name: string): string | undefined => {
  const value: unknown = Object.getOwnPropertyDescriptor(error, name)?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

export const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const detail = stringField(error, 'detail');
  const remediation = stringField(error, 'remediation');
  return [error.message, ...(detail === undefined ? [] : [`  detail: ${detail}`]), ...(remediation === undefined ? [] : [`  remedy: ${remediation}`])].join('\n');
};
