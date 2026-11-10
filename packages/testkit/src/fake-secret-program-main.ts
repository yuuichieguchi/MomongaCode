import fs from 'node:fs';
import path from 'node:path';
import { SECRET_TOOL_BINARY, SECURITY_BINARY } from '@momonga/foundation';
import { createFakeLoginKeychain, fakeMissingKeychainOf, readFakeSecretControl, recordFakeSecretEnded, recordFakeSecretHanging } from './fake-secret-programs.ts';
import { createFakeSecurityPort } from './fake-secrets.ts';

const PROTOCOL_FAKES: Readonly<Record<string, string>> = { security: SECURITY_BINARY, 'secret-tool': SECRET_TOOL_BINARY };
const ENDED_BY_SIGTERM_EXIT = 143;
const LONGEST_INTERVAL_MS = 2 ** 30;

const [items, program, ...args] = process.argv.slice(2);
if (items === undefined || program === undefined) throw new Error('fake secret program: the items directory and the program name are required');

const readItems = (): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(items).filter((name) => !name.startsWith('.')).map((name) => [name, fs.readFileSync(path.join(items, name), 'utf8')]));

const writeItem = (name: string, value: string): void => {
  const staging = path.join(items, `.${name}.${process.pid}`);
  fs.writeFileSync(staging, value, { mode: 0o600 });
  fs.renameSync(staging, path.join(items, name));
};

const stayAliveUntilEnded = (): void => {
  process.once('SIGTERM', () => {
    recordFakeSecretEnded(items, program, args);
    process.exit(ENDED_BY_SIGTERM_EXIT);
  });
  setInterval(() => undefined, LONGEST_INTERVAL_MS);
  recordFakeSecretHanging(items, program, args);
};

const canonical = Object.hasOwn(PROTOCOL_FAKES, program) ? PROTOCOL_FAKES[program] : undefined;
if (canonical === undefined) {
  process.stderr.write(`fake ${program}: no fake of this program's protocol exists; a test run never reaches the real ${program}\n`);
  process.exitCode = 2;
} else {
  const control = readFakeSecretControl(items);
  const asksReadiness = program === 'security' && args.length === 1 && args[0] === 'default-keychain';
  if ((asksReadiness ? control.readiness : control.calls) === 'hang') {
    stayAliveUntilEnded();
  } else {
    const keychainPath = asksReadiness && control.readiness === 'ready' ? createFakeLoginKeychain(items) : fakeMissingKeychainOf(items);
    const takesStdin = (program === 'security' && args[0] === '-i') || (program === 'secret-tool' && args[0] === 'store');
    const stdin = takesStdin ? fs.readFileSync(0, 'utf8') : '';
    const result = await createFakeSecurityPort(readItems, writeItem, { control: () => control, keychainPath })(canonical, args, stdin, new AbortController().signal);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  }
}
