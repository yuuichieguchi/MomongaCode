import fs from 'node:fs';
import path from 'node:path';
import { createKeyedSerializer, isRecord, withFileLock, writeFileAtomically } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { settingsLockPath } from './file-lock.ts';
import { layoutOf } from './layout.ts';
import { localSettingsDirectory, reRootedRule, worktreeRootOf } from './local-settings.ts';
import { readJsonFile } from './json-file.ts';
import { parseRule } from './rule.ts';
import type { RuleEffect } from './rule.ts';

export type AppendPermissionRuleOptions = {
  home: string;
  projectDir: string;
  ports: FileLockPorts;
  lockTimeoutMs?: number;
  rule: string;
  effect: RuleEffect;
};

const SETTINGS_FILE_MODE = 0o600;

const serializeInProcess = createKeyedSerializer();

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

export const appendPermissionRule = async ({ home, projectDir, rule, effect, ports, lockTimeoutMs }: AppendPermissionRuleOptions): Promise<void> => {
  const directory = await localSettingsDirectory(home, projectDir);
  const file = path.join(directory, 'settings.local.json');
  const root = await worktreeRootOf(home, projectDir);
  const stored = reRootedRule(rule, await fs.promises.realpath(projectDir), root);
  parseRule(stored, { effect, origin: 'local', source: file, settingsRoot: root, home, cwd: projectDir });

  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(layoutOf(home).run, { recursive: true, mode: 0o700 });
  await serializeInProcess(file, () =>
    withFileLock(settingsLockPath(home, file), async () => {
      const read = await readJsonFile(file);
      let document: Record<string, unknown> = {};
      if (read.found) {
        if (!isRecord(read.value)) throw new Error(`${file}: settings must be a JSON object`);
        document = read.value;
      }
      if (!addRule(document, file, stored, effect)) return;
      await writeFileAtomically(file, `${JSON.stringify(document, null, 2)}\n`, { mode: SETTINGS_FILE_MODE, randomHex: ports.randomHex });
    }, { ports, ...(lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs }) }),
  );
};
