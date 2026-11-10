import { ruleEnforcementOf } from '@momonga/foundation';
import type { Sandbox } from '@momonga/sandbox';
import type { SandboxBindings } from '../ports.ts';

export const fixedSandboxBindings = (sandbox: Sandbox): SandboxBindings => {
  const binding = { sandbox, ruleEnforcement: ruleEnforcementOf(sandbox.kind) };
  return { acquire: async () => ({ value: binding, release: () => undefined }) };
};
