export const AUTO_MODE_UNAVAILABLE = { code: 'mode_unavailable', message: 'auto mode is not available yet' } as const;

export const isUnavailableMode = (mode: string | undefined): boolean => mode === 'auto';
