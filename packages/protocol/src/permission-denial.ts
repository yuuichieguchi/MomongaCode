export const PERMISSION_DENIAL_SOURCES = ['sandbox', 'rule', 'mode', 'hook'] as const;

export type PermissionDenialSource = (typeof PERMISSION_DENIAL_SOURCES)[number];

export type PermissionDenial = { source: PermissionDenialSource; reason: string };

export const APPROVAL_BASES = ['read_only', 'rule', 'mode', 'hook', 'classifier', 'person'] as const;

export type ApprovalBasis = (typeof APPROVAL_BASES)[number];

export const permissionDeniedOutput = (denial: PermissionDenial): string => `Permission denied: ${denial.reason}`;
