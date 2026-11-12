export type ChildProtection = { readonly kind: 'home-denied'; readonly home: string; readonly denied: readonly string[] } | { readonly kind: 'unprotected'; readonly reason: string };

export type ChildLaunch = { protection: ChildProtection; commandOf(argv: readonly string[], scratch: readonly string[]): { file: string; args: string[] } };

export type LaunchProtection = ChildProtection | { readonly kind: 'sandboxed'; readonly backend: 'seatbelt' | 'bubblewrap' } | { readonly kind: 'control-plane' };

export const CONTROL_PLANE_LAUNCH: LaunchProtection = { kind: 'control-plane' };
