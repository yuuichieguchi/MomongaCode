import type { Dirent } from 'node:fs';
import path from 'node:path';
import { markIgnored, settledOrAborted } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { unownedOf } from '@momonga/tools';
import type { MarkerOwners } from '@momonga/tools';
import { notFound } from './errors.ts';
import type { RouteRegistrar } from './app.ts';

export type MarkerRoutesDeps = {
  markerDirectories: (signal: AbortSignal) => Promise<readonly string[]>;
  owners: MarkerOwners;
  files: FileSystem;
};

const markerFilesNamed = async (files: FileSystem, dir: string, name: string, signal: AbortSignal): Promise<string[]> => {
  let entries: Dirent[];
  try {
    entries = await settledOrAborted(files.readdirEntries(dir), signal);
  } catch (error) {
    if (!signal.aborted && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return markerFilesNamed(files, full, name, signal);
      return Promise.resolve(entry.isFile() && entry.name === name ? [full] : []);
    }),
  );
  return nested.flat();
};

export const registerMarkerRoutes = (route: RouteRegistrar, deps: MarkerRoutesDeps): void => {
  const markerFilesOf = async (name: string, signal: AbortSignal): Promise<string[]> =>
    (await Promise.all((await settledOrAborted(deps.markerDirectories(signal), signal)).map((directory) => markerFilesNamed(deps.files, directory, name, signal)))).flat();

  route('/v1/markers/:name/ignore', {
    POST: async (context) => {
      const signal = context.req.raw.signal;
      const name = context.req.param('name') ?? '';
      const markers = unownedOf([name], deps.owners).length === 0 ? [] : await markerFilesOf(name, signal);
      if (markers.length === 0) throw notFound('no unsettled marker has that name');
      await Promise.all(markers.map((marker) => settledOrAborted(markIgnored(marker, { signal }), signal)));
      return new Response(null, { status: 204 });
    },
  }, { person: ['POST'] });
};
