import fs from 'node:fs';
import path from 'node:path';
import { SECURITY_BINARY } from '@momonga/foundation';
import { createFakeSecurityPort } from './fake-secrets.ts';

const [items, ...args] = process.argv.slice(2);
if (items === undefined) throw new Error('fake security: the items directory is required');

const readItems = (): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(items).filter((name) => !name.startsWith('.')).map((name) => [name, fs.readFileSync(path.join(items, name), 'utf8')]));

const writeItem = (name: string, value: string): void => {
  const staging = path.join(items, `.${name}.${process.pid}`);
  fs.writeFileSync(staging, value, { mode: 0o600 });
  fs.renameSync(staging, path.join(items, name));
};

const stdin = args[0] === '-i' ? fs.readFileSync(0, 'utf8') : '';
const result = await createFakeSecurityPort(readItems, writeItem)(SECURITY_BINARY, args, stdin, new AbortController().signal);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
