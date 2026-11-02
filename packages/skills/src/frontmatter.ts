import { parseDocument } from 'yaml';

export type SkillFileParse =
  | { kind: 'parsed'; fields: Readonly<Record<string, unknown>>; body: string }
  | { kind: 'invalid'; reason: string };

const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const KEY_VALUE_LINE = /^(\s*)([A-Za-z0-9_-]+):[ \t]+(.+?)[ \t]*$/;
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?\d*$/;
const QUOTED_OR_STRUCTURED_START = /^["'|>[{&*!#%@`]/;
const NOT_A_MAPPING = 'the frontmatter must be a YAML mapping';
const AMBIGUOUS_COLON = /:(?:[ \t]|$)/;

const indentationOf = (line: string): number => line.length - line.trimStart().length;

const quoteAmbiguousValues = (yamlText: string): string => {
  let blockIndentation: number | undefined;
  return yamlText
    .split(/\r?\n/)
    .map((line) => {
      if (blockIndentation !== undefined) {
        if (line.trim() === '' || indentationOf(line) > blockIndentation) return line;
        blockIndentation = undefined;
      }
      const match = KEY_VALUE_LINE.exec(line);
      if (match === null) return line;
      const [, indentation = '', key = '', value = ''] = match;
      if (BLOCK_SCALAR_INDICATOR.test(value)) {
        blockIndentation = indentation.length;
        return line;
      }
      if (QUOTED_OR_STRUCTURED_START.test(value) || !AMBIGUOUS_COLON.test(value)) return line;
      return `${indentation}${key}: ${JSON.stringify(value)}`;
    })
    .join('\n');
};

type MappingParse = { kind: 'mapping'; fields: Record<string, unknown> } | { kind: 'syntax'; message: string } | { kind: 'shape' };

const parseMapping = (yamlText: string): MappingParse => {
  const document = parseDocument(yamlText, { logLevel: 'silent', uniqueKeys: true });
  const [firstError] = document.errors;
  if (firstError !== undefined) return { kind: 'syntax', message: firstError.message };
  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    if (error instanceof ReferenceError) return { kind: 'syntax', message: error.message };
    throw error;
  }
  if (value === null || value === undefined) return { kind: 'mapping', fields: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'shape' };
  return { kind: 'mapping', fields: { ...value } };
};

export const parseSkillFile = (text: string): SkillFileParse => {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { kind: 'invalid', reason: 'the file does not start with YAML frontmatter delimited by --- lines' };
  const yamlText = match[1] ?? '';
  const body = text.slice(match[0].length).trim();
  const strict = parseMapping(yamlText);
  if (strict.kind === 'mapping') return { kind: 'parsed', fields: strict.fields, body };
  if (strict.kind === 'shape') return { kind: 'invalid', reason: NOT_A_MAPPING };
  const lenient = parseMapping(quoteAmbiguousValues(yamlText));
  if (lenient.kind === 'mapping') return { kind: 'parsed', fields: lenient.fields, body };
  return { kind: 'invalid', reason: `the frontmatter is not valid YAML: ${strict.message}` };
};
