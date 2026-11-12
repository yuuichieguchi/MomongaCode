import fs from 'node:fs';
import path from 'node:path';

export type CfgNames = {
  readonly constants: Readonly<Record<string, string>>;
  readonly invariants: readonly string[];
  readonly properties: readonly string[];
};

const SECTIONS = { CONSTANTS: 'constants', INVARIANTS: 'invariants', PROPERTIES: 'properties' } as const;

const SINGULAR = new Set(['CONSTANT', 'INVARIANT', 'PROPERTY']);

type Section = (typeof SECTIONS)[keyof typeof SECTIONS];

const sectionOf = (keyword: string): Section | undefined => (Object.hasOwn(SECTIONS, keyword) ? SECTIONS[keyword as keyof typeof SECTIONS] : undefined);

export const cfgNamesOf = (text: string, source: string): CfgNames => {
  const constants: Record<string, string> = {};
  const invariants: string[] = [];
  const properties: string[] = [];
  let section: Section | undefined;
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\S/.test(line)) {
      const [keyword = '', ...rest] = line.trim().split(/\s+/);
      if (SINGULAR.has(keyword)) throw new Error(`${source}:${index + 1}: the keyword ${keyword} is written in its plural form ${keyword === 'PROPERTY' ? 'PROPERTIES' : `${keyword}S`} in this repository`);
      section = sectionOf(keyword);
      if (section !== undefined && rest.length > 0) throw new Error(`${source}:${index + 1}: the names of ${keyword} stand on the lines below it, one per line`);
      continue;
    }
    const name = line.trim();
    if (name === '' || section === undefined) continue;
    if (section === 'constants') {
      const assignment = /^(\w+)\s*(=|<-)\s*(.+)$/.exec(name);
      if (assignment === null) throw new Error(`${source}:${index + 1}: a constant is written as Name = value or Name <- Definition`);
      constants[assignment[1] as string] = (assignment[3] as string).trim();
    } else if (section === 'invariants') {
      invariants.push(name);
    } else {
      properties.push(name);
    }
  }
  return { constants, invariants, properties };
};

export const cfgNames = (specDir: string, config: string): CfgNames => {
  const file = path.join(specDir, `${config}.cfg`);
  return cfgNamesOf(fs.readFileSync(file, 'utf8'), file);
};
