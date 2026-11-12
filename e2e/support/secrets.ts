import path from 'node:path';
import type { E2eHome } from './home.ts';
import { spawnPty } from './pty.ts';

export const secretNameOf = (home: E2eHome, base: string): string => `${base}-${path.basename(home.root).slice(-6).toLowerCase()}`;

export const storeSecretThroughProduct = async (home: E2eHome, name: string, value: string): Promise<void> => {
  const pty = await spawnPty(home, ['secret', 'set', name]);
  await pty.waitFor(`Value for secret ${name} (input is hidden): `);
  pty.write(`${value}\r`);
  await pty.waitFor('Enter it again to confirm: ');
  pty.write(`${value}\r`);
  await pty.waitFor(`stored secret ${name}`);
  const exit = await pty.exit();
  if (exit.code !== 0) throw new Error(`momonga secret set ${name} exited with ${JSON.stringify(exit)}: ${pty.screen()}`);
};
