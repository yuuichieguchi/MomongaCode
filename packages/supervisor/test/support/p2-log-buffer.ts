import { createJsonLogger } from '@momonga/foundation';
import type { Clock, JsonLogger } from '@momonga/foundation';
import { parseJsonLines } from '@momonga/testkit';
import type { JsonLine } from '@momonga/testkit';

export type LogBuffer = { logger: JsonLogger; lines(): JsonLine[]; events(msg: string): JsonLine[]; writes(): number };

export const createLogBuffer = (clock: Clock, options: { accept?: boolean } = {}): LogBuffer => {
  const raw: string[] = [];
  let writes = 0;
  const logger = createJsonLogger({
    service: 'supervisor',
    clock,
    stream: {
      write: (chunk: string) => {
        writes += 1;
        if (options.accept !== false) raw.push(...chunk.split('\n').filter((line) => line.length > 0));
        return options.accept !== false;
      },
    },
  });
  return {
    logger,
    lines: () => parseJsonLines(raw),
    events: (msg) => parseJsonLines(raw).filter((line) => line['msg'] === msg),
    writes: () => writes,
  };
};
