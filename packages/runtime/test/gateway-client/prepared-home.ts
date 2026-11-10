import { FIRST_GENERATION, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { prepareGenerationForTest } from '@momonga/testkit';

export const prepareGatewayHome = async (home: string): Promise<void> => {
  await ensureMomongaDirs(momongaPaths(home, process.platform, {}));
  prepareGenerationForTest(home, FIRST_GENERATION, '1.10.0-test');
};
