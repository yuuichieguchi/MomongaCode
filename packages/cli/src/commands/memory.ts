import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';
import type { MemoryScope, MemoryView } from '@momonga/protocol';
import type { RuntimeClient } from '../client/runtime-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { formatMemory, formatMemoryHistory, formatMemoryList } from '../memory/format.ts';
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

export const memoryHistory = async (ports: CliPorts, paths: MomongaPaths, id: string, json: boolean): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const memories = await client.memoryHistory(id);
    ports.stdout.write(`${json ? JSON.stringify(memories) : formatMemoryHistory(memories)}\n`);
    return 0;
  } finally {
    await client.close();
  }
};

export const memoryReview = async (ports: CliPorts, paths: MomongaPaths, options: { json: boolean }): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const waiting = await client.memories({ state: 'candidate', project: ports.cwd });
    if (options.json) ports.stdout.write(`${JSON.stringify(waiting)}\n`);
    else if (waiting.length === 0) ports.stdout.write('no memories waiting for review\n');
    else ports.stdout.write(`${waiting.map(formatMemory).join('\n\n')}\n\nmomonga memory review accept <id> keeps a memory, momonga memory review reject <id> discards it\n`);
    return 0;
  } finally {
    await client.close();
  }
};

const changeMemory =
  (change: (client: RuntimeClient, id: string) => Promise<MemoryView>, past: string) =>
  async (ports: CliPorts, paths: MomongaPaths, id: string): Promise<number> => {
    await ensureDaemon(ports, paths);
    const client = connectRuntime(paths);
    try {
      const memory = await change(client, id);
      ports.stdout.write(`${past} memory ${memory.id}\n`);
      return 0;
    } finally {
      await client.close();
    }
  };

export const memoryAccept = changeMemory((client, id) => client.acceptMemory(id), 'accepted');

export const memoryReject = changeMemory((client, id) => client.rejectMemory(id), 'rejected');

export const memoryRestore = changeMemory((client, id) => client.restoreMemory(id), 'restored');

export const memoryPromote = async (ports: CliPorts, paths: MomongaPaths, id: string, skill: string): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const file = await client.promoteMemory(id, skill);
    ports.stdout.write(`promoted memory ${id} to the skill ${skill}: ${file}\n`);
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
