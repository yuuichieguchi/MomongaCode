import { readCurrentGeneration } from './current-generation.ts';
import type { MomongaPaths } from './momonga-paths.ts';
import type { JsonLogger } from './process-contract.ts';

export type GenerationRole = 'starting' | 'serving' | 'retiring';

export type UnreadableGenerationRole = { kind: 'unreadable'; reason: string };

export const roleOfGeneration = (generation: number, currentGeneration: number | undefined): GenerationRole => {
  if (currentGeneration === undefined || currentGeneration < generation) return 'starting';
  return currentGeneration === generation ? 'serving' : 'retiring';
};

export const readGenerationRole = async (paths: MomongaPaths, generation: number): Promise<GenerationRole | UnreadableGenerationRole> => {
  try {
    return roleOfGeneration(generation, (await readCurrentGeneration(paths))?.generation);
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
};

export type RolePort = {
  current(): GenerationRole;
  refresh(): Promise<GenerationRole>;
};

export type RolePortOptions = { paths: MomongaPaths; generation: number; logger: Pick<JsonLogger, 'warn'> };

export const GENERATION_ROLE_UNREADABLE_EVENT = 'generation.role_unreadable';

export const createRolePort = ({ paths, generation, logger }: RolePortOptions): RolePort => {
  let role: GenerationRole = 'starting';
  let reportedReason: string | undefined;
  return {
    current: () => role,
    refresh: async () => {
      const read = await readGenerationRole(paths, generation);
      if (typeof read === 'string') {
        role = read;
        reportedReason = undefined;
        return role;
      }
      if (read.reason !== reportedReason) {
        reportedReason = read.reason;
        logger.warn(GENERATION_ROLE_UNREADABLE_EVENT, { data: { generation, reason: read.reason } });
      }
      return role;
    },
  };
};

export const fixedRolePort = (role: GenerationRole): RolePort => ({ current: () => role, refresh: async () => role });
