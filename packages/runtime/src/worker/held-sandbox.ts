import type { RuleEnforcement } from '@momonga/foundation';
import type { Sandbox } from '@momonga/sandbox';
import type { SandboxBindings } from '../ports.ts';

export type HeldSandbox = { readonly sandbox: Sandbox; readonly ruleEnforcement: RuleEnforcement; done(): void };

export const holdSandbox = async (bindings: SandboxBindings, signal: AbortSignal): Promise<HeldSandbox> => {
  const lease = await bindings.acquire(signal);
  const { sandbox: bound, ruleEnforcement } = lease.value;
  let holders = 1;
  const letGo = (): void => {
    holders -= 1;
    if (holders === 0) lease.release();
  };
  const sandbox: Sandbox = {
    kind: bound.kind,
    spawn: async (command, policy, spawnSignal, descriptors) => {
      const child = await bound.spawn(command, policy, spawnSignal, descriptors);
      holders += 1;
      void child.exited.then(letGo, letGo);
      return child;
    },
  };
  let finished = false;
  return {
    sandbox,
    ruleEnforcement,
    done: () => {
      if (finished) return;
      finished = true;
      letGo();
    },
  };
};
