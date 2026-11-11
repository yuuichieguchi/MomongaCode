import path from 'node:path';
import { isRecord } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { askerOf } from './asker.ts';
import { isAbsentPathError, parseJsonText, readJsonText } from './json-file.ts';
import type { ResolvedSettings } from './load-settings.ts';

export type DeclaredCheckSource = 'package.json' | 'Makefile' | 'justfile';

export type DeclaredCheck = { readonly source: DeclaredCheckSource; readonly command: string };

export type AcceptedCheck = { readonly commands: readonly string[] } | { readonly declined: true };

type DeclaredCheckReader = { readonly source: DeclaredCheckSource; readonly command: string; readonly declares: (text: string, file: string) => boolean };

const MAKE_RULE_TEST = /^test[ \t]*:(?![:=])/m;

const JUST_RECIPE_TEST = /^@?test(?:[ \t]+[^:=\n]*)?[ \t]*:(?!=)/m;

const declaresNpmTest = (text: string, file: string): boolean => {
  const manifest = parseJsonText(text, file);
  const scripts = isRecord(manifest) ? manifest['scripts'] : undefined;
  return isRecord(scripts) && typeof scripts['test'] === 'string';
};

export const DECLARED_CHECK_SOURCES: readonly DeclaredCheckReader[] = [
  { source: 'package.json', command: 'npm test', declares: declaresNpmTest },
  { source: 'Makefile', command: 'make test', declares: (text) => MAKE_RULE_TEST.test(text) },
  { source: 'justfile', command: 'just test', declares: (text) => JUST_RECIPE_TEST.test(text) },
];

export const declaredChecksOf = async (projectDir: string, files: FileSystem, signal: AbortSignal): Promise<readonly DeclaredCheck[]> => {
  const asker = askerOf(signal, files);
  const found: DeclaredCheck[] = [];
  for (const { source, command, declares } of DECLARED_CHECK_SOURCES) {
    const file = path.join(projectDir, source);
    const read = await readJsonText(file, isAbsentPathError, asker, { confine: { paths: asker.paths, to: projectDir } });
    if (read.found && declares(read.text, file)) found.push({ source, command });
  }
  return found;
};

export const acceptedCheckOf = (settings: ResolvedSettings, projectDir: string): AcceptedCheck | undefined => {
  const checks = settings.projectChecks;
  if (checks === undefined || !Object.hasOwn(checks, projectDir)) return undefined;
  return checks[projectDir];
};
