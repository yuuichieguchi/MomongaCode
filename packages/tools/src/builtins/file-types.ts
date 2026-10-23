import { ToolInputError } from '../types.ts';

export const TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  js: ['js', 'jsx', 'mjs', 'cjs'],
  ts: ['ts', 'tsx', 'mts', 'cts'],
  py: ['py', 'pyi'],
  rs: ['rs'],
  go: ['go'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'h'],
  md: ['md', 'markdown'],
  json: ['json'],
  yaml: ['yaml', 'yml'],
  sh: ['sh', 'bash', 'zsh'],
  swift: ['swift'],
  rb: ['rb'],
};

export const extensionsForType = (type: string): readonly string[] => {
  const extensions = Object.hasOwn(TYPE_EXTENSIONS, type) ? TYPE_EXTENSIONS[type] : undefined;
  if (extensions === undefined) {
    throw new ToolInputError(`Unknown file type "${type}". Known types: ${Object.keys(TYPE_EXTENSIONS).join(', ')}`);
  }
  return extensions;
};
