import { createRedactor } from '@momonga/foundation';

const redactor = createRedactor({ credentials: [] });

export type MemoryTextProblem = { code: 'blank' | 'credential'; message: string };

export const memoryTextProblem = (text: string): MemoryTextProblem | undefined => {
  if (text.trim() === '') return { code: 'blank', message: 'text must contain more than whitespace' };
  if (redactor.text(text) !== text) {
    return { code: 'credential', message: 'The memory was not saved because it looks like it contains a credential or secret. State the fact without the secret.' };
  }
  return undefined;
};
