import path from 'node:path';
import { InvalidArgumentError } from 'commander';
import type { MomongaPaths } from '@momonga/foundation';
import type { MemoryKind, MemoryScope, MemoryView } from '@momonga/protocol';
import type { RuntimeClient } from '../client/runtime-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { formatMemory, formatMemoryHistory, formatMemoryList, formatReflection } from '../memory/format.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';

export type MemoryAddOptions = { kind?: MemoryKind; user: boolean; paths: readonly string[]; json: boolean };

export const memoryAdd = async (ports: CliPorts, paths: MomongaPaths, text: string, options: MemoryAddOptions): Promise<number> => {
  if (options.user && options.paths.length > 0) throw new InvalidArgumentError('--path binds a memory to files of this folder, so it cannot be combined with --user');
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const memory = await client.addMemory({
      text,
      scope: options.user ? 'user' : 'project',
      ...(options.user ? {} : { project: ports.cwd }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.paths.length === 0 ? {} : { paths: options.paths.map((given) => path.relative(ports.cwd, path.resolve(ports.cwd, given)) || '.') }),
    });
    ports.stdout.write(`${options.json ? JSON.stringify(memory) : `added memory ${memory.id} (${memory.scope}, ${memory.status})`}\n`);
    return 0;
  } finally {
    await client.close();
  }
};

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
    else if (waiting.length === 0) ports.stdout.write(`no memories waiting for review\n${formatReflection(await client.lastReflection(ports.cwd))}\n`);
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
