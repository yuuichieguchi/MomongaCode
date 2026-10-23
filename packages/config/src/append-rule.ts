import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from './file-lock.ts';
import { localSettingsDirectory } from './local-settings.ts';
import { readJsonFile } from './json-file.ts';
import { parseRule } from './rule.ts';
import type { RuleEffect } from './rule.ts';

export type AppendPermissionRuleOptions = {
  home: string;
  projectDir: string;
  lockTimeoutMs?: number;
  rule: string;
  effect: RuleEffect;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const inProcessQueues = new Map<string, Promise<void>>();

const serializeInProcess = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = inProcessQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inProcessQueues.set(key, settled);
  void settled.then(() => {
    if (inProcessQueues.get(key) === settled) inProcessQueues.delete(key);
  });
  return run;
};

const writeAtomically = async (file: string, content: string): Promise<void> => {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, file);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
  const directory = await fs.promises.open(path.dirname(file), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
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

export const appendPermissionRule = async ({ home, projectDir, rule, effect, lockTimeoutMs }: AppendPermissionRuleOptions): Promise<void> => {
  const directory = await localSettingsDirectory(home, projectDir);
  const file = path.join(directory, 'settings.local.json');
  parseRule(rule, { effect, origin: 'local', source: file, settingsRoot: projectDir, home, cwd: projectDir });

  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await serializeInProcess(file, () =>
    withFileLock(`${file}.lock`, async () => {
      const read = await readJsonFile(file);
      let document: Record<string, unknown> = {};
      if (read.found) {
        if (!isRecord(read.value)) throw new Error(`${file}: settings must be a JSON object`);
        document = read.value;
      }
      if (!addRule(document, file, rule, effect)) return;
      await writeAtomically(file, `${JSON.stringify(document, null, 2)}\n`);
    }, lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs }),
  );
};
