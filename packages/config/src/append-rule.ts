import path from 'node:path';
import { isRecord } from '@momonga/foundation';
import type { FileLockPorts, KernelLockMechanism } from '@momonga/foundation';
import { asked, askerOf } from './asker.ts';
import { editUserSettings } from './edit-user-settings.ts';
import { settingsWriterPorts } from './file-lock.ts';
import { localSettingsDirectory, reRootedRule, worktreeRootOf } from './local-settings.ts';
import { NETWORK_RULE_SUBJECT, checkRuleText, parseRule } from './rule.ts';
import { userSettingsFile } from './layers.ts';
import type { RuleEffect } from './rule.ts';

export type AppendPermissionRuleOptions = {
  home: string;
  projectDir: string;
  lock: KernelLockMechanism;
  ports: FileLockPorts;
  lockTimeoutMs?: number;
  rule: string;
  effect: RuleEffect;
  signal: AbortSignal;
};

const addRule = (document: Record<string, unknown>, file: string, rule: string, effect: RuleEffect): boolean => {
  const permissions = document['permissions'];
  if (permissions !== undefined && !isRecord(permissions)) throw new Error(`${file}: "permissions" must be an object`);
  const target = permissions ?? {};
  const existing = target[effect];
  if (existing !== undefined && !Array.isArray(existing)) throw new Error(`${file}: "permissions.${effect}" must be an array`);
  if (existing?.includes(rule) === true) return false;
  target[effect] = [...(existing ?? []), rule];
  document['permissions'] = target;
  return true;
};

export const settingsLayerOfRule = (rule: string): 'local' | 'user' => (checkRuleText(rule).tool === NETWORK_RULE_SUBJECT ? 'user' : 'local');

export const appendPermissionRule = async ({ home, projectDir, rule, effect, lock, ports, lockTimeoutMs, signal }: AppendPermissionRuleOptions): Promise<void> => {
  const writer = settingsWriterPorts(home, { lock, ports, signal, ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }) });
  if (settingsLayerOfRule(rule) === 'user') {
    const file = userSettingsFile(home);
    parseRule(rule, { effect, origin: 'user', source: file, settingsRoot: home, home, cwd: projectDir });
    await editUserSettings(file, (document) => addRule(document, file, rule, effect), writer);
    return;
  }
  const asker = askerOf(signal);
  const directory = await localSettingsDirectory(home, projectDir, asker);
  const file = path.join(directory, 'settings.local.json');
  const root = await worktreeRootOf(home, projectDir, asker);
  const stored = reRootedRule(rule, await asked(asker, asker.files.realpath(projectDir)), root);
  parseRule(stored, { effect, origin: 'local', source: file, settingsRoot: root, home, cwd: projectDir });

  await editUserSettings(file, (document) => addRule(document, file, stored, effect), writer);
};

