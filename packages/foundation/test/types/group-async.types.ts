import { groupAlive, signalGroup } from '../../src/process-group.ts';
import type { ProcessGroupPort } from '../../src/platform/group-port.ts';

export const usesGroupsSynchronously = (port: ProcessGroupPort): void => {
  // @ts-expect-error
  const alive: boolean = groupAlive(4242, port);
  // @ts-expect-error
  const sent: void = signalGroup(4242, 'SIGTERM', port);
  // @ts-expect-error
  const portAlive: boolean = port.alive(4242, { signal: AbortSignal.abort() });
  void [alive, sent, portAlive];
};
