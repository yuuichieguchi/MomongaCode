export const windowProblem = (ceiling: number | undefined): string => (ceiling === undefined ? 'Enter a whole number of at least 1.' : `Enter a whole number from 1 to ${ceiling}.`);

export const wholeNumberWithin = (text: string, ceiling: number | undefined): number | undefined => {
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isInteger(value) || value < 1) return undefined;
  return ceiling !== undefined && value > ceiling ? undefined : value;
};
