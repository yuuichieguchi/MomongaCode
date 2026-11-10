import type { AnyMessage } from '@agentclientprotocol/sdk';

export type MessageStream = { readable: ReadableStream<AnyMessage>; writable: WritableStream<AnyMessage> };

export const REPLAYED_INITIALIZE_ID = 'momonga-handover-initialize';

const answersReplay = (message: AnyMessage): boolean => !('method' in message) && 'id' in message && message.id === REPLAYED_INITIALIZE_ID;

export const withReplayedInitialize = (stream: MessageStream, initialize: unknown): MessageStream => {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  let replayed = false;
  return {
    readable: new ReadableStream<AnyMessage>({
      pull: async (controller) => {
        if (!replayed) {
          replayed = true;
          controller.enqueue({ jsonrpc: '2.0', id: REPLAYED_INITIALIZE_ID, method: 'initialize', params: initialize });
          return;
        }
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    writable: new WritableStream<AnyMessage>({
      write: async (message) => {
        if (!answersReplay(message)) await writer.write(message);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  };
};
