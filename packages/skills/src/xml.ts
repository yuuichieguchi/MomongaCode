const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export const escapeText = (value: string): string => value.replace(/[&<>]/g, (character) => ESCAPES[character] ?? character);
