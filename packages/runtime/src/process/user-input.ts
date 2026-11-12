import type { Stats } from 'node:fs';
import path from 'node:path';
import { attachMentions } from '@momonga/context';
import type { AttachHost, AttachTarget } from '@momonga/context';
import { OPEN_FLAGS, createPathResolver, settledOrAborted, someAsync } from '@momonga/foundation';
import type { Clock, FileSystem } from '@momonga/foundation';
import { tokensForText } from '@momonga/protocol';
import type { ProtectionOnlySandbox } from '@momonga/sandbox';
import type { RuntimeStore, Session } from '@momonga/store';
import { listDirectoryEntries, runUserCommand } from '@momonga/tools';
import type { UserPolicy, UserPolicyFacts } from '@momonga/tools';
import { permissionRulesFor } from '../governance/rules.ts';
import type { SettingsPort, ToolRuntimePort, UserInputPort } from '../ports.ts';
import { holdSandbox } from '../worker/held-sandbox.ts';

export type UserInputOptions = {
  tools: Pick<ToolRuntimePort, 'envFor' | 'policyFor' | 'sandboxes' | 'sessionState' | 'shellHost'>;
  policy: UserPolicy;
  store: Pick<RuntimeStore, 'governing'>;
  settings: Pick<SettingsPort, 'rules' | 'trusted' | 'tools'>;
  clock: Clock;
  home: string;
  unsandboxed: ProtectionOnlySandbox;
  files: FileSystem;
};

export const readMentionFile = async (files: FileSystem, absolute: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> => {
  const handle = await settledOrAborted(files.openRead(absolute, OPEN_FLAGS.readOnly), signal);
  try {
    const buffer = Buffer.alloc(maxBytes);
    let filled = 0;
    for (;;) {
      const bytesRead = await settledOrAborted(handle.readAt(buffer.subarray(filled), filled), signal);
      filled += bytesRead;
      if (bytesRead === 0 || filled === maxBytes) return buffer.subarray(0, filled);
    }
  } finally {
    await handle.close();
  }
};

export const mentionTargetOf = async (
  files: FileSystem,
  session: Pick<Session, 'cwd'>,
  roots: readonly string[],
  mention: string,
  signal: AbortSignal,
): Promise<AttachTarget | 'outside' | undefined> => {
  let absolute: string;
  let stat: Stats;
  try {
    absolute = await settledOrAborted(files.realpath(path.resolve(session.cwd, mention)), signal);
    stat = await settledOrAborted(files.stat(absolute), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') return undefined;
    throw error;
  }
  const paths = createPathResolver(files, signal);
  if (!(await someAsync(roots, (root) => paths.comparableContains(root, absolute)))) return 'outside';
  if (stat.isDirectory()) return { absolute, shown: mention, kind: 'directory', size: 0 };
  return stat.isFile() ? { absolute, shown: mention, kind: 'file', size: stat.size } : undefined;
};

export const createUserInputPort = ({ tools, policy, store, settings, clock, home, unsandboxed, files }: UserInputOptions): UserInputPort => {
  const factsFor = async (session: Session, signal: AbortSignal): Promise<UserPolicyFacts> => {
    const held = await holdSandbox(tools.sandboxes, signal);
    try {
      const env = await tools.envFor(session, signal);
      const rules = await permissionRulesFor({ store, settings, clock, home }, session, signal);
      const policy = await tools.policyFor(session, { env, rules, ruleEnforcement: held.ruleEnforcement, signal });
      return { home, roots: policy.roots, tmpDir: policy.tmpDir, env, session: tools.sessionState(session), signal, rules, sandboxPolicy: policy.sandboxPolicy };
    } finally {
      held.done();
    }
  };

  return {
    attach: async (session, text, { ceiling, imageInput, signal }) => {
      const facts = await factsFor(session, signal);
      const trusted = await settings.trusted(session, signal);
      const host: AttachHost = {
        ceiling,
        imageInput,
        trusted,
        tokens: tokensForText,
        resolve: (mention) => mentionTargetOf(files, session, facts.roots, mention, signal),
        floor: async (absolute) => ((await policy.userRefusal({ tool: 'Read', path: absolute }, facts)) === undefined ? 'allowed' : 'denied'),
        read: (absolute, maxBytes) => readMentionFile(files, absolute, maxBytes, signal),
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
        shellHost: tools.shellHost,
        signal: io.signal,
        refusal: (asked) => policy.userRefusal({ tool: 'Bash', command: asked }, facts),
        spawn: (spawned, signal) => {
          if (unsandboxed.protection.kind === 'unprotected') io.onUnprotected(unsandboxed.protection.reason);
          return unsandboxed.spawn(spawned, facts.sandboxPolicy, signal);
        },
        onOutput: io.onOutput,
        drainIdleMs: (await settings.tools(session, io.signal)).bash.drainIdleMs,
      });
    },
  };
};
