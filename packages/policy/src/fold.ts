export const foldedKey = (text: string): string => text.normalize('NFD').toUpperCase().toLowerCase();
