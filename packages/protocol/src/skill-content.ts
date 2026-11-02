const ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };

export const escapeXmlAttribute = (value: string): string => value.replace(/[&"<>]/g, (character) => ATTRIBUTE_ESCAPES[character] ?? character);

export const skillContentOpenTag = (name: string): string => `<skill_content name="${escapeXmlAttribute(name)}">`;

export const SKILL_CONTENT_CLOSE_TAG = '</skill_content>';
