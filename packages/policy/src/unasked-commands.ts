import { commandSpecsFor } from './platform-specs.ts';

export type UnaskedCommands = { readOnly: readonly string[]; edit: readonly string[] };

export const unaskedCommandsFor = (platform: NodeJS.Platform): UnaskedCommands => {
  const specs = commandSpecsFor(platform).all;
  const namesMarked = (approval: 'read-only' | 'edit'): string[] => specs.filter((spec) => spec.approval === approval).flatMap((spec) => [...spec.names]);
  return { readOnly: namesMarked('read-only'), edit: namesMarked('edit') };
};
