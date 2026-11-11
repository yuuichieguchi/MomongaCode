import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as foundation from '@momonga/foundation';
import { EXIT_CODES } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });

const OWN_EXIT_CONSTANT = /\b(?:const|let|var)\s+(\w*EXIT\w*)\s*(?::[^=]+)?=\s*(?:0x[0-9a-f]+|\d+)\b/;
const NOT_A_CODE = /_(?:MS|SIGNALS)$/;
const LITERAL_PROCESS_EXIT = /\bprocess\.exit\(\s*\d|\bprocess\.exitCode\s*=\s*\d/;
const EXIT_NAME = /\bEXIT_[A-Z_]+\b/g;

const linesOf = (file: string): { where: string; text: string }[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .map((text, index) => ({ where: `${path.relative(SOURCE_ROOT, file)}:${index + 1}`, text }));

const everyLine = sourceFiles(SOURCE_ROOT).flatMap(linesOf);

describe('the exit codes of packages/cli/src', () => {
  it('declares no exit code of its own: every one is a value of the one table', () => {
    expect(everyLine.filter((line) => !NOT_A_CODE.test(OWN_EXIT_CONSTANT.exec(line.text)?.[1] ?? '_MS')).map((line) => `${line.where}: ${line.text.trim()}`)).toEqual([]);
  });

  it('gives process.exit and process.exitCode no literal number', () => {
    expect(everyLine.filter((line) => LITERAL_PROCESS_EXIT.test(line.text)).map((line) => `${line.where}: ${line.text.trim()}`)).toEqual([]);
  });

  it('uses only exit names the table exports', () => {
    const exported = new Set(Object.keys(foundation));
    const unknown = everyLine.flatMap((line) => (line.text.match(EXIT_NAME) ?? []).filter((name) => !NOT_A_CODE.test(name) && !exported.has(name)).map((name) => `${line.where}: ${name}`));
    expect(unknown).toEqual([]);
  });

  it('reads the table: usage is 2, waiting for approval is 75, 76 is reserved, the held daemon lock is 77, interrupted is 130', () => {
    expect([EXIT_CODES.usage.code, EXIT_CODES.waitingForApproval.code, EXIT_CODES.versionMismatchReserved.code, EXIT_CODES.alreadyRunning.code, EXIT_CODES.interrupted.code]).toEqual([2, 75, 76, 77, 130]);
  });
});
