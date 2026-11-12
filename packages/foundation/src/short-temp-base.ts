export const SHORT_TEMP_BASE = '/tmp';

export const shortTempBase = (platform: NodeJS.Platform, temporaryDirectory: string): string => (platform === 'win32' ? temporaryDirectory : SHORT_TEMP_BASE);
