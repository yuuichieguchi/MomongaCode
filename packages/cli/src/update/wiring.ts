import type { MomongaPaths } from '@momonga/foundation';
import type { CliPorts } from '../ports.ts';
import type { UpdateWiring } from './background.ts';
import { buildUpdateInputs } from './build-info.ts';
import { nodeUpdatePorts } from './node-ports.ts';
import { GITHUB_ENDPOINTS } from './source.ts';

export const nodeUpdateWiring = (ports: CliPorts, paths: MomongaPaths): UpdateWiring => ({
  ports: nodeUpdatePorts(ports, paths),
  build: buildUpdateInputs(),
  endpoints: GITHUB_ENDPOINTS,
});
