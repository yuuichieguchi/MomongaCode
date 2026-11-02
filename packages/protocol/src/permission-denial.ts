export const PERMISSION_DENIAL_SOURCES = ['sandbox', 'rule', 'mode', 'hook'] as const;

export type PermissionDenialSource = (typeof PERMISSION_DENIAL_SOURCES)[number];

export type PermissionDenial = { source: PermissionDenialSource; reason: string };

export const permissionDeniedOutput = (denial: PermissionDenial): string => `Permission denied: ${denial.reason}`;
