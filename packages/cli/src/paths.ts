import { canonicalPath, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { CliPorts } from './ports.ts';

export const pathsOf = (ports: Pick<CliPorts, 'home' | 'platform'>): MomongaPaths => momongaPaths(canonicalPath(ports.home), ports.platform, {});
