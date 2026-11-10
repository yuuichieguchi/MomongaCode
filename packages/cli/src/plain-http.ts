import { loadUserModels, plainHttpWarningText } from '@momonga/config';
import type { UserModels } from '@momonga/config';
import { escapedLines } from './terminal-writer.ts';

type Announcer = { home: string; stderr: { write(text: string): void } };

const announced = new Set<string>();

export const announcePlainHttp = (ports: Announcer, servers: readonly string[]): void => {
  for (const server of servers) {
    const key = `${ports.home}\n${server}`;
    if (announced.has(key)) continue;
    announced.add(key);
    ports.stderr.write(`${escapedLines([`momonga: ${plainHttpWarningText(server)}`])}\n`);
  }
};

export const shellModelsOf = (ports: Announcer): UserModels => {
  const models = loadUserModels({ home: ports.home });
  announcePlainHttp(ports, models.resolved.plainHttp);
  return models;
};
