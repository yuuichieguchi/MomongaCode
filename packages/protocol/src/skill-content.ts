import { escapeXmlAttribute } from './xml.ts';

export const skillContentOpenTag = (name: string): string => `<skill_content name="${escapeXmlAttribute(name)}">`;

export const SKILL_CONTENT_CLOSE_TAG = '</skill_content>';
