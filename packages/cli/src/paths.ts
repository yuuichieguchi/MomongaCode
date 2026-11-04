import { canonicalPath, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { CliPorts } from './ports.ts';

export const pathsOf = async (ports: Pick<CliPorts, 'home' | 'platform'>): Promise<MomongaPaths> => {
  const paths = momongaPaths(canonicalPath(ports.home), ports.platform, {});
  await ensureMomongaDirs(paths, { platform: ports.platform });
  return paths;
};
