export const WRAPUP_INSTRUCTIONS_VERSION = 1;

export type WrapUpReason = 'max_steps' | 'budget' | 'context';

export const wrapUpInstructionFor = (reason: WrapUpReason): string =>
  reason === 'context'
    ? "The conversation no longer fits the model's context window. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools."
    : `You have reached the ${reason} limit. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools.`;

export const summaryStopReason = (step: number, maxSteps: number): 'max_steps' | 'budget' =>
  step - 1 >= maxSteps ? 'max_steps' : 'budget';
