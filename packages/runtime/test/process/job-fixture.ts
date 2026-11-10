import fs from 'node:fs';
import path from 'node:path';
import { fixedRolePort } from '@momonga/foundation';
import type { RolePort } from '@momonga/foundation';

export type JobGenerationOptions = {
  generation: number;
  jobsDir: string;
  role: Pick<RolePort, 'current'>;
  markerDirOf(ownerGeneration: number): string;
  ownerAlive(ownerGeneration: number): Promise<boolean>;
};

export const jobGenerationOptions = (root: string, overrides: Partial<JobGenerationOptions> = {}): JobGenerationOptions => {
  const jobsDir = path.join(root, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  return {
    generation: 1,
    jobsDir,
    role: fixedRolePort('serving'),
    markerDirOf: (ownerGeneration) => path.join(root, `markers-g${ownerGeneration}`),
    ownerAlive: async () => false,
    ...overrides,
  };
};
