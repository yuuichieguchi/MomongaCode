import type { ContextChargesView } from '@momonga/protocol';
import type { ContextCharge } from '@momonga/store';

export const contextChargesView = (charges: readonly ContextCharge[]): ContextChargesView => ({
  charges: [...charges],
  totalTokens: charges.reduce((sum, charge) => sum + charge.totalTokens, 0),
});

export const contextChargesText = (view: ContextChargesView): string =>
  view.charges.length === 0
    ? ''
    : [
        'context charges (model calls made for context purposes):',
        ...view.charges.map(
          (charge) =>
            `${charge.purpose} ${charge.runId === null ? 'no run' : `run ${charge.runId}`} ${charge.model}: ${charge.inputTokens} input + ${charge.outputTokens} output = ${charge.totalTokens} tokens, ${charge.project}`,
        ),
        `context charges total: ${view.totalTokens} tokens`,
      ].join('\n');
