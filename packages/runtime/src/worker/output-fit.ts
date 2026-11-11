import { fitToTokens, itemCapFor, outputRenderOf } from '@momonga/context';
import type { TokenMeter } from '@momonga/context';
import { OUTPUT_READER_TOOL } from '@momonga/foundation';
import { tokensForText } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import type { OutputCall, OutputFit } from '@momonga/tools';

type CallCount = (text: string, call: OutputCall) => number | Promise<number>;

const outputFitOf = (input: { count: CallCount; itemCap: () => Promise<number> }): OutputFit => {
  let cap: Promise<number> | undefined;
  const capOf = (): Promise<number> => (cap ??= input.itemCap());
  return {
    ready: async () => {
      await capOf();
    },
    fits: async (text, call) => (await input.count(text, call)) <= (await capOf()),
    fit: async (text, handle, call) => fitToTokens({ text, cap: await capOf(), handle, reader: OUTPUT_READER_TOOL, count: (cut) => input.count(cut, call) }),
  };
};

export const meteredOutputFit = (input: { meter: TokenMeter; itemCap: () => Promise<number>; harnessTools: ReadonlySet<string>; fence: string }): OutputFit =>
  outputFitOf({
    count: (text, call) =>
      input.meter.countItem(outputRenderOf({ type: 'function_call_output', call_id: call.callId, output: text }, call.tool, input.harnessTools, false, input.fence).full, {
        callNames: { [call.callId]: call.tool },
        withTools: true,
      }),
    itemCap: input.itemCap,
  });

export const reconcileOutputFit = (capabilities: Capabilities): OutputFit =>
  outputFitOf({ count: (text) => tokensForText(text), itemCap: async () => itemCapFor(capabilities) });
