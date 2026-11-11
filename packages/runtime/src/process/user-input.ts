import fs from 'node:fs';
import path from 'node:path';
import { attachMentions } from '@momonga/context';
import type { AttachHost, AttachTarget } from '@momonga/context';
import { hostPaths, someAsync } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { tokensForText } from '@momonga/protocol';
import type { Sandbox } from '@momonga/sandbox';
import type { RuntimeStore, Session } from '@momonga/store';
import { listDirectoryEntries, runUserCommand } from '@momonga/tools';
import type { UserPolicy, UserPolicyFacts } from '@momonga/tools';
import { permissionRulesFor } from '../governance/rules.ts';
import type { SettingsPort, ToolRuntimePort, UserInputPort } from '../ports.ts';
import { holdSandbox } from '../worker/held-sandbox.ts';

export type UserInputOptions = {
  tools: Pick<ToolRuntimePort, 'envFor' | 'policyFor' | 'sandboxes' | 'sessionState'>;
  policy: UserPolicy;
  store: Pick<RuntimeStore, 'governing'>;
  settings: Pick<SettingsPort, 'rules' | 'trusted'>;
  clock: Clock;
  home: string;
  unsandboxed: Sandbox;
};

const readBounded = async (absolute: string, maxBytes: number): Promise<Uint8Array> => {
  const handle = await fs.promises.open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, maxBytes - filled, filled);
      filled += bytesRead;
      if (bytesRead === 0 || filled === maxBytes) return buffer.subarray(0, filled);
    }
  } finally {
    await handle.close();
  }
};

const targetOf = async (session: Session, roots: readonly string[], mention: string, signal: AbortSignal): Promise<AttachTarget | 'outside' | undefined> => {
  let absolute: string;
  let stat: fs.Stats;
  try {
    absolute = await fs.promises.realpath(path.resolve(session.cwd, mention));
    stat = await fs.promises.stat(absolute);
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return undefined;
    throw error;
  }
  if (!(await someAsync(roots, (root) => hostPaths(signal).comparableContains(root, absolute)))) return 'outside';
  if (stat.isDirectory()) return { absolute, shown: mention, kind: 'directory', size: 0 };
  return stat.isFile() ? { absolute, shown: mention, kind: 'file', size: stat.size } : undefined;
};

export const createUserInputPort = ({ tools, policy, store, settings, clock, home, unsandboxed }: UserInputOptions): UserInputPort => {
  const factsFor = async (session: Session, signal: AbortSignal): Promise<UserPolicyFacts> => {
    const held = await holdSandbox(tools.sandboxes, signal);
    try {
      const env = tools.envFor(session);
      const rules = await permissionRulesFor({ store, settings, clock, home }, session);
      const policy = await tools.policyFor(session, { env, rules, ruleEnforcement: held.ruleEnforcement, signal });
      return { home, roots: policy.roots, tmpDir: policy.tmpDir, env, session: tools.sessionState(session), signal, rules, sandboxPolicy: policy.sandboxPolicy };
    } finally {
      held.done();
    }
  };

  return {
    attach: async (session, text, { ceiling, imageInput, signal }) => {
      const facts = await factsFor(session, signal);
      const trusted = settings.trusted(session);
      const host: AttachHost = {
        ceiling,
        imageInput,
        trusted,
        tokens: tokensForText,
        resolve: (mention) => targetOf(session, facts.roots, mention, signal),
        floor: async (absolute) => ((await policy.userRefusal({ tool: 'Read', path: absolute }, facts)) === undefined ? 'allowed' : 'denied'),
        read: readBounded,
        list: (absolute) => listDirectoryEntries({ root: absolute, env: facts.env, trusted, signal }),
      };
      return attachMentions(text, host);
    },
    shell: async (session, command, io) => {
      const facts = await factsFor(session, io.signal);
      return runUserCommand({
        command,
        cwd: facts.session.cwd,
        env: facts.env,
        signal: io.signal,
        refusal: (asked) => policy.userRefusal({ tool: 'Bash', command: asked }, facts),
        spawn: (spawned, signal) => unsandboxed.spawn(spawned, facts.sandboxPolicy, signal),
        onOutput: io.onOutput,
      });
    },
  };
};
