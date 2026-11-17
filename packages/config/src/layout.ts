import { homeLayout, momongaLayout } from '@momonga/foundation';
import type { HomePaths, LayoutEnvironment } from '@momonga/foundation';

export const layoutOf = (home: string): HomePaths => homeLayout(home, process.platform);

export const keyStoreOf = (home: string, env: LayoutEnvironment): string => momongaLayout(home, process.platform, env).keychains;
