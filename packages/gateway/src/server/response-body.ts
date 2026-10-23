import type { ResponseResource, StreamEvent } from '@momonga/protocol';
import { TERMINAL_STREAM_EVENT_TYPES } from '@momonga/protocol';
import { ClientDisconnectedError, GatewayError, statusFor } from '../core/errors.ts';

export const collectTerminalResource = async (
  first: StreamEvent,
  rest: AsyncIterator<StreamEvent>,
): Promise<ResponseResource> => {
  let event: StreamEvent = first;
  for (;;) {
    if (event.type === 'response.failed') {
      const { error } = event.response;
      const type = error.type ?? 'server_error';
      throw new GatewayError({ status: statusFor(type, error.code), type, code: error.code, message: error.message });
    }
    if ((TERMINAL_STREAM_EVENT_TYPES as readonly string[]).includes(event.type)) {
      return (event as Extract<StreamEvent, { response: ResponseResource }>).response;
    }
    const step = await rest.next();
    if (step.done === true) throw new ClientDisconnectedError();
    event = step.value;
  }
};
