import os from 'node:os';

export const SHORT_TEMP_BASE = '/tmp';

export const shortTempBase = (platform: NodeJS.Platform): string => (platform === 'win32' ? os.tmpdir() : SHORT_TEMP_BASE);
