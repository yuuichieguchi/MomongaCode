import { ensureMomongaDirs, hostPaths, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { CliPorts } from './ports.ts';

export const pathsOf = async (ports: Pick<CliPorts, 'home' | 'platform' | 'interrupt'>): Promise<MomongaPaths> => {
  const paths = momongaPaths(await hostPaths(ports.interrupt).canonicalPath(ports.home), ports.platform, {});
  await ensureMomongaDirs(paths, { platform: ports.platform, signal: ports.interrupt });
  return paths;
};
