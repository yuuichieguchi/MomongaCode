import type { SandboxedProcess } from '@momonga/sandbox';
import { createTempDir, pollUntil } from '@momonga/testkit';

export function makeTempDir(): string {
  return createTempDir();
}

export async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function run(proc: SandboxedProcess): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  killedBy?: 'abort' | 'grace-kill';
}> {
  const [stdout, stderr, exit] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
  return { stdout, stderr, ...exit };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitUntilDead(pids: number[], timeoutMs: number): Promise<boolean> {
  await pollUntil(() => pids.every((pid) => !isAlive(pid)), { description: `processes ${pids.join(', ')} to die`, boundMs: timeoutMs });
  return true;
}
