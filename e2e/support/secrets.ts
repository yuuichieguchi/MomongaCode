import path from 'node:path';
import type { E2eHome } from './home.ts';
import { spawnPty } from './pty.ts';

export const secretNameOf = (home: E2eHome, base: string): string => `${base}-${path.basename(home.root).slice(-6).toLowerCase()}`;

export const storeSecretThroughProduct = async (home: E2eHome, name: string, value: string): Promise<void> => {
  const pty = await spawnPty(home, ['secret', 'set', name]);
  await pty.waitFor(`Value for secret ${name} (input is hidden): `);
  await pty.write(value);
  await pty.key('enter', { until: 'Enter it again to confirm: ' });
  await pty.write(value);
  await pty.key('enter', { until: `stored secret ${name}` });
  const { status, frame } = await pty.exit();
  if (status.code !== 0) throw new Error(`momonga secret set ${name} exited with ${JSON.stringify(status)}: ${frame.lines.join('\n')}`);
};
