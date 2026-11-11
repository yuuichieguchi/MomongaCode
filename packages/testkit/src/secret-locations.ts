import { momongaLayout, standardSecretLocations } from '@momonga/foundation';
import type { SecretLocation } from '@momonga/foundation';

export const testSecretLocations = (home: string, platform: NodeJS.Platform = process.platform): SecretLocation[] => standardSecretLocations(momongaLayout(home, platform, {}));
