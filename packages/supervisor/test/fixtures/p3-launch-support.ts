import { createJsonLogger } from '@momonga/foundation';
import type { JsonLogger } from '@momonga/foundation';
import type { JsonLine } from '@momonga/testkit';

export { fakeReapTiming } from '@momonga/testkit';

export const captureLog = (clock: { now(): number }, onMsg: (msg: string) => void) => {
  const lines: JsonLine[] = [];
  const logger: JsonLogger = createJsonLogger({
    service: 'supervisor',
    clock,
    stream: {
      write: (chunk) => {
        for (const text of chunk.split('\n')) {
          if (text === '') continue;
          const line = JSON.parse(text) as JsonLine;
          lines.push(line);
          onMsg(String(line.msg));
        }
        return true;
      },
    },
  });
  return { logger, withMsg: (msg: string) => lines.filter((line) => line.msg === msg) };
};
