import { homeLayout, momongaLayout } from '@momonga/foundation';
import type { HomePaths } from '@momonga/foundation';

export const layoutOf = (home: string): HomePaths => homeLayout(home, process.platform);

export const keyStoreOf = (home: string): string => momongaLayout(home, process.platform, process.env).keychains;
