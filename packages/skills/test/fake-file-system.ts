import type { DirectoryEntry, SkillFileSystem } from '@momonga/skills';

export type FakeSkillFileSystem = SkillFileSystem & { reads: string[]; listings: string[]; set(file: string, text: string): void; remove(file: string): void };

const parentOf = (target: string): string => target.slice(0, target.lastIndexOf('/')) || '/';

export const fakeSkillFileSystem = (files: Readonly<Record<string, string>> = {}, links: Readonly<Record<string, string>> = {}): FakeSkillFileSystem => {
  const contents = new Map(Object.entries(files));
  const reads: string[] = [];
  const listings: string[] = [];
  const resolve = (target: string): string => {
    for (const [link, destination] of Object.entries(links)) {
      if (target === link) return destination;
      if (target.startsWith(`${link}/`)) return `${destination}${target.slice(link.length)}`;
    }
    return target;
  };
  const directories = (): Set<string> => {
    const found = new Set<string>();
    for (const file of [...contents.keys(), ...Object.keys(links)]) {
      for (let directory = parentOf(file); directory !== '/' && !found.has(directory); directory = parentOf(directory)) found.add(directory);
    }
    return found;
  };
  return {
    reads,
    listings,
    set: (file, text) => {
      contents.set(file, text);
    },
    remove: (file) => {
      contents.delete(file);
    },
    listDirectory: async (directory) => {
      listings.push(directory);
      const real = resolve(directory);
      if (!directories().has(real)) return undefined;
      const entries = new Map<string, 'file' | 'directory'>();
      for (const file of contents.keys()) {
        if (!file.startsWith(`${real}/`)) continue;
        const [first, ...rest] = file.slice(real.length + 1).split('/');
        if (first !== undefined) entries.set(first, rest.length === 0 ? 'file' : 'directory');
      }
      for (const link of Object.keys(links)) {
        if (parentOf(link) === real) entries.set(link.slice(real.length + 1), 'directory');
      }
      return [...entries].map(([name, kind]) => ({ name, kind }));
    },
    readText: async (file) => {
      reads.push(file);
      return contents.get(resolve(file));
    },
    realpath: async (target) => {
      const real = resolve(target);
      return directories().has(real) || contents.has(real) ? real : undefined;
    },
  };
};

export const skillFile = (name: string | undefined, description: string | undefined, body = 'Do the work.'): string =>
  ['---', ...(name === undefined ? [] : [`name: ${name}`]), ...(description === undefined ? [] : [`description: ${description}`]), '---', body, ''].join('\n');
