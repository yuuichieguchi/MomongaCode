export const ENGINE_ROOT_BASE = 'ata://root';

export const rootUriOf = (root: Record<string, unknown>): string => {
  const id = root['$id'];
  if (typeof id !== 'string') return ENGINE_ROOT_BASE;
  try {
    const resolved = new URL(id, ENGINE_ROOT_BASE);
    resolved.hash = '';
    return resolved.href;
  } catch {
    return ENGINE_ROOT_BASE;
  }
};
