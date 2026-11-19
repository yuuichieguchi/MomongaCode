export type KeyValueStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const STORAGE_REFUSALS: readonly string[] = ['SecurityError', 'QuotaExceededError'];

const refusesStorage = (error: unknown): boolean => error instanceof DOMException && STORAGE_REFUSALS.includes(error.name);

export const readStored = (store: () => KeyValueStore, key: string): string | null => {
  try {
    return store().getItem(key);
  } catch (error) {
    if (refusesStorage(error)) return null;
    throw error;
  }
};

export const writeStored = (store: () => KeyValueStore, key: string, value: string): void => {
  try {
    store().setItem(key, value);
  } catch (error) {
    if (!refusesStorage(error)) throw error;
  }
};
