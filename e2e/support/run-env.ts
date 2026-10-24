import path from 'node:path';

export const E2E_RUN_ENV = 'MOMONGA_E2E_RUN';
export const E2E_RUN_PATTERN = /^[0-9a-f]{4}$/;
export const E2E_DIR_PREFIX = 'mme-';
export const LIVE_MARKER_SUFFIX = 'live';
export const PIDS_FILE_SUFFIX = 'pids';

export const e2eEntryPrefix = (run: string): string => `${E2E_DIR_PREFIX}${run}-`;

export const harnessFilePath = (tmpRoot: string, run: string, suffix: string): string => path.join(tmpRoot, `${e2eEntryPrefix(run)}${suffix}`);
