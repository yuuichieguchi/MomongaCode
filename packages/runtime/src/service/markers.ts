import fs from 'node:fs';
import path from 'node:path';
import { markIgnored } from '@momonga/foundation';
import { unownedOf } from '@momonga/tools';
import type { MarkerOwners } from '@momonga/tools';
import { notFound } from './errors.ts';
import type { RouteRegistrar } from './app.ts';

export type MarkerRoutesDeps = {
  markerDirectories: () => Promise<readonly string[]>;
  owners: MarkerOwners;
  closeSignal: AbortSignal;
};

const markerFilesNamed = async (dir: string, name: string): Promise<string[]> => {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return markerFilesNamed(full, name);
      return Promise.resolve(entry.isFile() && entry.name === name ? [full] : []);
    }),
  );
  return nested.flat();
};

export const registerMarkerRoutes = (route: RouteRegistrar, deps: MarkerRoutesDeps): void => {
  const markerFilesOf = async (name: string): Promise<string[]> => (await Promise.all((await deps.markerDirectories()).map((directory) => markerFilesNamed(directory, name)))).flat();

  route('/v1/markers/:name/ignore', {
    POST: async (context) => {
      const name = context.req.param('name') ?? '';
      const markers = unownedOf([name], deps.owners).length === 0 ? [] : await markerFilesOf(name);
      if (markers.length === 0) throw notFound('no unsettled marker has that name');
      await Promise.all(markers.map((marker) => markIgnored(marker, { signal: deps.closeSignal })));
      return new Response(null, { status: 204 });
    },
  });
};
