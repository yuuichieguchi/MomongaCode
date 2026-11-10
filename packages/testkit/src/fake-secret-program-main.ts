import fs from 'node:fs';
import path from 'node:path';
import { SECRET_TOOL_BINARY, SECURITY_BINARY } from '@momonga/foundation';
import { createFakeSecurityPort } from './fake-secrets.ts';

const PROTOCOL_FAKES: Readonly<Record<string, string>> = { security: SECURITY_BINARY, 'secret-tool': SECRET_TOOL_BINARY };

const [items, program, ...args] = process.argv.slice(2);
if (items === undefined || program === undefined) throw new Error('fake secret program: the items directory and the program name are required');

const readItems = (): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(items).filter((name) => !name.startsWith('.')).map((name) => [name, fs.readFileSync(path.join(items, name), 'utf8')]));

const writeItem = (name: string, value: string): void => {
  const staging = path.join(items, `.${name}.${process.pid}`);
  fs.writeFileSync(staging, value, { mode: 0o600 });
  fs.renameSync(staging, path.join(items, name));
};

const canonical = Object.hasOwn(PROTOCOL_FAKES, program) ? PROTOCOL_FAKES[program] : undefined;
if (canonical === undefined) {
  process.stderr.write(`fake ${program}: no fake of this program's protocol exists; a test run never reaches the real ${program}\n`);
  process.exitCode = 2;
} else {
  const takesStdin = (program === 'security' && args[0] === '-i') || (program === 'secret-tool' && args[0] === 'store');
  const stdin = takesStdin ? fs.readFileSync(0, 'utf8') : '';
  const result = await createFakeSecurityPort(readItems, writeItem)(canonical, args, stdin, new AbortController().signal);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
