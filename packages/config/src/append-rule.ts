import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { editUserSettings } from './edit-user-settings.ts';
import { localSettingsDirectory, reRootedRule, worktreeRootOf } from './local-settings.ts';
import { parseRule } from './rule.ts';
import type { RuleEffect } from './rule.ts';

export type AppendPermissionRuleOptions = {
  home: string;
  projectDir: string;
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

export const appendPermissionRule = async ({ home, projectDir, rule, effect, ports, lockTimeoutMs, signal }: AppendPermissionRuleOptions): Promise<void> => {
  const directory = await localSettingsDirectory(home, projectDir);
  const file = path.join(directory, 'settings.local.json');
  const root = await worktreeRootOf(home, projectDir);
  const stored = reRootedRule(rule, await fs.promises.realpath(projectDir), root);
  parseRule(stored, { effect, origin: 'local', source: file, settingsRoot: root, home, cwd: projectDir });

  await editUserSettings(home, file, (document) => addRule(document, file, stored, effect), { ports, signal, ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }) });
};
