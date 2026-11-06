import { fitToTokens, itemCapFor } from '@momonga/context';
import type { TokenCount, TokenMeter } from '@momonga/context';
import { OUTPUT_READER_TOOL } from '@momonga/foundation';
import { tokensForText } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import type { OutputFit } from '@momonga/tools';

const OUTPUT_CALL_ID = 'output-fit';

const outputFitOf = (input: { count: TokenCount; itemCap: () => Promise<number> }): OutputFit => {
  let cap: Promise<number> | undefined;
  const capOf = (): Promise<number> => (cap ??= input.itemCap());
  return {
    ready: async () => {
      await capOf();
    },
    fits: async (text) => (await input.count(text)) <= (await capOf()),
    fit: async (text, handle) => fitToTokens({ text, cap: await capOf(), handle, reader: OUTPUT_READER_TOOL, count: input.count }),
  };
};

export const meteredOutputFit = (input: { meter: TokenMeter; itemCap: () => Promise<number> }): OutputFit =>
  outputFitOf({
    count: (text) => input.meter.countItem({ type: 'function_call_output', call_id: OUTPUT_CALL_ID, output: text }, { callNames: {}, withTools: true }),
    itemCap: input.itemCap,
  });

export const reconcileOutputFit = (capabilities: Capabilities): OutputFit =>
  outputFitOf({ count: tokensForText, itemCap: async () => itemCapFor(capabilities) });
