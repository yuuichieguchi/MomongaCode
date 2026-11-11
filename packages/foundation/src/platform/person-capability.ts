import { homeLayout } from '../momonga-paths.ts';
import { ownerOnlySecret } from './owner-only-secret.ts';
import type { OwnerOnlySecretPorts } from './owner-only-secret.ts';

export const PERSON_CAPABILITY_FILE = 'person-capability';

export const personCapabilityOf = async (ports: OwnerOnlySecretPorts, home: string): Promise<string> => {
  const { root } = homeLayout(home);
  await ports.files.mkdirPrivate(root);
  return ownerOnlySecret(ports, root, PERSON_CAPABILITY_FILE);
};
