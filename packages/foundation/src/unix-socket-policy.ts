export type UnixSocketPolicy = { readonly kind: 'limited'; readonly allowed: readonly string[] } | { readonly kind: 'not_limited' };

export const unixSocketPolicyOf = (sandbox: 'seatbelt' | 'bubblewrap' | 'none', allowed: readonly string[]): UnixSocketPolicy =>
  sandbox === 'none' ? { kind: 'not_limited' } : { kind: 'limited', allowed: [...allowed] };
