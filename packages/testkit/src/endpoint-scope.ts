import { endpointScopeOf, nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { EndpointScope, MomongaPaths } from '@momonga/foundation';
import { testKernelLock } from './test-locks.ts';

export const testEndpointScope = (paths: Pick<MomongaPaths, 'run'>): Promise<EndpointScope> =>
  endpointScopeOf(paths, process.platform, { files: nodeFileSystem, random: systemRandom, lock: testKernelLock() });
