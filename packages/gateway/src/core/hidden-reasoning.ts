import { tokensForText } from './estimate.ts';

export type HiddenReasoningSignals = {
  reportedReasoningTokens: number | undefined;
  reasoningText: string | undefined;
  completionTokens: number | undefined;
  visibleText: string;
};

export const hiddenReasoningTokens = (signals: HiddenReasoningSignals): number | undefined => {
  if (signals.reportedReasoningTokens !== undefined) return signals.reportedReasoningTokens;
  if (signals.reasoningText !== undefined && signals.reasoningText !== '') return tokensForText(signals.reasoningText);
  if (signals.completionTokens !== undefined) return Math.max(0, signals.completionTokens - tokensForText(signals.visibleText));
  return signals.reasoningText === undefined ? undefined : 0;
};
