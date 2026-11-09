import path from 'node:path';
import { markIgnored, momongaLayout } from '@momonga/foundation';
import { unsettledKeys } from '@momonga/tools';
import type { MarkerOwners } from '@momonga/tools';
import { notFound } from './errors.ts';
import type { RouteRegistrar } from './app.ts';

export type MarkerRoutesDeps = {
  home: string;
  owners: MarkerOwners;
  closeSignal: AbortSignal;
};

export const registerMarkerRoutes = (route: RouteRegistrar, deps: MarkerRoutesDeps): void => {
  const markerDir = momongaLayout(deps.home).markers.tools;

  route('/v1/markers/:name/ignore', {
    POST: async (context) => {
      const name = context.req.param('name') ?? '';
      if (!(await unsettledKeys(markerDir, deps.owners)).includes(name)) throw notFound('no unsettled marker has that name');
      await markIgnored(path.join(markerDir, name), { signal: deps.closeSignal });
      return new Response(null, { status: 204 });
    },
  });
};
