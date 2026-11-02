export type ConfigPrograms = { keys: string[] };

const HEADER = /^\[([A-Za-z0-9-]+)(?:\.([^\s"\]]+)|[ \t]+"((?:[^"\\]|\\.)*)")?\][ \t]*(.*)$/;
const ASSIGNMENT = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=|$)/;
const DRIVER_KEYS: Readonly<Record<string, readonly string[]>> = { filter: ['clean', 'smudge', 'process'], diff: ['command', 'textconv'] };
const INCLUDING_SECTIONS: ReadonlySet<string> = new Set(['include', 'includeif']);
const INCLUDE_KEY = 'include';

type Section = { name: string; subsection: string | undefined };

const programKeyOf = (section: Section, key: string): string | undefined => {
  if (INCLUDING_SECTIONS.has(section.name)) return INCLUDE_KEY;
  if (section.name === 'diff' && section.subsection === undefined && key === 'external') return 'diff.external';
  if (section.subsection !== undefined && DRIVER_KEYS[section.name]?.includes(key) === true) return `${section.name}.${section.subsection}.${key}`;
  return undefined;
};

export const programKeysOfConfig = (text: string): string[] => {
  const found: string[] = [];
  let section: Section | undefined;
  let continued = false;
  const record = (line: string): void => {
    const assignment = ASSIGNMENT.exec(line);
    if (assignment === null || section === undefined) return;
    const key = programKeyOf(section, (assignment[1] as string).toLowerCase());
    if (key !== undefined && !found.includes(key)) found.push(key);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const wasContinued = continued;
    continued = /(?:^|[^\\])(?:\\\\)*\\$/.test(raw);
    if (wasContinued || line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = HEADER.exec(line);
    if (header === null) {
      record(line);
      continue;
    }
    const legacy = header[2];
    section = {
      name: (header[1] as string).toLowerCase(),
      subsection: header[3] !== undefined ? header[3].replace(/\\(.)/g, '$1') : legacy?.toLowerCase(),
    };
    if (INCLUDING_SECTIONS.has(section.name) && !found.includes(INCLUDE_KEY)) found.push(INCLUDE_KEY);
    record(header[4] as string);
  }
  return found;
};
