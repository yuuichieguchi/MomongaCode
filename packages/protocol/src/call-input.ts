import type { InputItem } from './open-responses.ts';
import type { RunEvent } from './run-types.ts';

export const callInputTracker = (parse: (text: string) => unknown) => {
  const inputs = new Map<string, unknown>();
  return {
    observe(event: RunEvent): void {
      if (event.type !== 'model.responded') return;
      for (const item of event.response.output as InputItem[]) {
        if (item.type === 'function_call') inputs.set(item.call_id, parse(item.arguments));
      }
    },
    inputOf(event: { callId: string; rawInput?: unknown }): unknown {
      return event.rawInput !== undefined ? event.rawInput : inputs.get(event.callId);
    },
  };
};
