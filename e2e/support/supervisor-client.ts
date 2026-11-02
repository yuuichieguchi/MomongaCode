import type { SupervisorChildHealth, SupervisorHealth, SupervisorPhase, SupervisorShutdownResponse } from '@momonga/protocol';
import { createSupervisorClient as createProductClient } from '../../packages/cli/src/client/supervisor-client.ts';
import type { ChildRole } from '../../packages/cli/src/client/supervisor-client.ts';
import type { E2eHome } from './home.ts';
import { until } from './wait.ts';

export { childOf, pidOf } from '../../packages/cli/src/client/supervisor-client.ts';
export type { ChildRole };

export type SupervisorClient = {
  health(): Promise<SupervisorHealth>;
  shutdown(): Promise<{ status: number; body: SupervisorShutdownResponse }>;
  untilPhase(phase: SupervisorPhase, deadlineMs: number): Promise<SupervisorHealth>;
  untilChild(role: ChildRole, predicate: (child: SupervisorChildHealth) => boolean, deadlineMs: number): Promise<SupervisorChildHealth>;
  close(): Promise<void>;
};

export const createSupervisorClient = (home: E2eHome): SupervisorClient => {
  const product = createProductClient({ socketPath: home.paths.sockets.supervisor, onHealth: (body) => home.ledger.record(body) });

  const shutdown = async (): Promise<{ status: number; body: SupervisorShutdownResponse }> => {
    await product.health();
    return product.shutdown();
  };

  const untilPhase = (phase: SupervisorPhase, deadlineMs: number): Promise<SupervisorHealth> =>
    until(async () => {
      const current = await product.health();
      return current.phase === phase ? current : undefined;
    }, { deadlineMs, description: `supervisor phase ${phase}` });

  const untilChild = (role: ChildRole, predicate: (child: SupervisorChildHealth) => boolean, deadlineMs: number): Promise<SupervisorChildHealth> =>
    until(async () => {
      const health = await product.health();
      const child = health.children.find((entry) => entry.role === role);
      if (child === undefined) throw new Error(`no ${role} child in health`);
      return predicate(child) ? child : undefined;
    }, { deadlineMs, description: `${role} child to match the awaited state` });

  return { health: () => product.health(), shutdown, untilPhase, untilChild, close: () => product.close() };
};
