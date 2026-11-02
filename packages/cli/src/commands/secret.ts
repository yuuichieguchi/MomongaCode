import { SECRET_NAME_PATTERN } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { createSupervisorClient } from '../client/supervisor-client.ts';
import { probeSupervisor } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { withHiddenInput } from '../terminal/hidden-prompt.ts';

export class SecretInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretInputError';
  }
}

export class SecretVerificationError extends Error {
  constructor(name: string) {
    super(`the secret "${name}" was written but reading it back did not return the entered value`);
    this.name = 'SecretVerificationError';
  }
}

const NAME_SHAPE = new RegExp(SECRET_NAME_PATTERN);

export const secretSet = async (ports: CliPorts, paths: MomongaPaths, name: string, interrupt: AbortSignal): Promise<number> => {
  if (!NAME_SHAPE.test(name)) throw new SecretInputError(`secret name ${JSON.stringify(name)} does not match ${SECRET_NAME_PATTERN}`);
  if (ports.terminal === undefined) throw new SecretInputError('momonga secret set reads the value from the terminal; run it in an interactive terminal');
  const value = await withHiddenInput(ports.terminal, interrupt, async (read) => {
    const entered = await read(`Value for secret ${name} (input is hidden): `);
    if (entered === '') throw new SecretInputError('a secret value must not be empty');
    if ((await read('Enter it again to confirm: ')) !== entered) throw new SecretInputError('the two entries differ; nothing was stored');
    return entered;
  });
  const store = ports.secretStore();
  await store.write(name, value, interrupt);
  if ((await store.read(name, interrupt)) !== value) throw new SecretVerificationError(name);
  ports.stdout.write(`stored secret ${name}\n`);
  const supervisor = createSupervisorClient({ socketPath: paths.sockets.supervisor });
  try {
    if ((await probeSupervisor(supervisor)) !== undefined) {
      ports.stdout.write('the running daemon keeps a value of this secret it has already read; run `momonga daemon stop` so that the gateway reads the new one\n');
    }
  } finally {
    await supervisor.close();
  }
  return 0;
};
