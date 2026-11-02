const TEXT_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = { ...TEXT_ESCAPES, '"': '&quot;' };

export const escapeXmlText = (value: string): string => value.replace(/[&<>]/g, (character) => TEXT_ESCAPES[character] ?? character);

export const escapeXmlAttribute = (value: string): string => value.replace(/[&<>"]/g, (character) => ATTRIBUTE_ESCAPES[character] ?? character);
