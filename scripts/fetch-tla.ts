import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_SETUP_COMMAND = 'npm run test:setup';

export const tlaJarPathOf = (root: string): string => path.join(root, '.cache', 'tla', 'tla2tools.jar');

export const requireTlaJar = (root: string): string => {
  const jar = tlaJarPathOf(root);
  if (!fs.existsSync(jar)) throw new Error(`${jar} is missing: run ${TEST_SETUP_COMMAND}`);
  return jar;
};

export const fetchTlaJar = (root: string, env: NodeJS.ProcessEnv): string => {
  execFileSync('bash', [path.join(root, 'scripts', 'tlc.sh'), '--fetch-jar'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return requireTlaJar(root);
};

if (import.meta.main) {
  process.stdout.write(`${fetchTlaJar(fileURLToPath(new URL('..', import.meta.url)), process.env)}\n`);
}
