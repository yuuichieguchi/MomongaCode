import { canonicalPath, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { CliPorts } from './ports.ts';

export const pathsOf = (ports: Pick<CliPorts, 'home'>): MomongaPaths => momongaPaths(canonicalPath(ports.home), process.platform, {});
