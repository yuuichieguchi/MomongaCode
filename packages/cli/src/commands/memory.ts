import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';
import type { MemoryScope } from '@momonga/protocol';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { formatMemory, formatMemoryList } from '../memory/format.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';

export type MemoryListOptions = { scope?: MemoryScope; project?: string; json: boolean };

export const memoryList = async (ports: CliPorts, paths: MomongaPaths, options: MemoryListOptions): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const memories = await client.memories({
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.project === undefined ? {} : { project: path.resolve(ports.cwd, options.project) }),
    });
    ports.stdout.write(`${options.json ? JSON.stringify(memories) : formatMemoryList(memories)}\n`);
    return 0;
  } finally {
    await client.close();
  }
};

export const memoryShow = async (ports: CliPorts, paths: MomongaPaths, id: string, json: boolean): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const memory = await client.memory(id);
    ports.stdout.write(`${json ? JSON.stringify(memory) : formatMemory(memory)}\n`);
    return 0;
  } finally {
    await client.close();
  }
};

export const memoryDelete = async (ports: CliPorts, paths: MomongaPaths, id: string): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    await client.deleteMemory(id);
    ports.stdout.write(`deleted memory ${id}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
