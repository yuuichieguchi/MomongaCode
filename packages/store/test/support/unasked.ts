import type { UnaskedCommands } from '@momonga/store';

export const UNASKED_COMMANDS: UnaskedCommands = { readOnly: ['ls', 'cat', 'git'], edit: ['mkdir', 'rm'] };
