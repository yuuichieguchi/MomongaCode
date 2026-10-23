import { momongaLayout } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';

export const layoutOf = (home: string): MomongaPaths => momongaLayout(home, process.platform, {});
