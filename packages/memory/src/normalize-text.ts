export const normalizeMemoryText = (text: string): string => text.normalize('NFC').trim().replace(/\s+/gu, ' ');
