import type { GenerationRole, RolePort } from '@momonga/foundation';

export type MutableRole = { port: RolePort; set(role: GenerationRole): void; refreshes(): number };

export const mutableRole = (initial: GenerationRole): MutableRole => {
  let role = initial;
  let refreshes = 0;
  return {
    port: {
      current: () => role,
      refresh: async () => {
        refreshes += 1;
        return role;
      },
    },
    set: (next) => {
      role = next;
    },
    refreshes: () => refreshes,
  };
};
