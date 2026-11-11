import fs from 'node:fs';
import path from 'node:path';

export const TEST_OPENER_RECORD_ENV = 'MOMONGA_TEST_OPENER_RECORD';

export type OpenerCall = { readonly program: string; readonly args: readonly string[] };

const RECORD_FILE_OF_THE_RUN = '.opened';

export const openerRecordIn = (items: string): string => path.join(items, RECORD_FILE_OF_THE_RUN);

export const recordOpenerCall = (file: string, call: OpenerCall): void => {
  fs.appendFileSync(file, `${JSON.stringify({ program: call.program, args: call.args })}\n`, { mode: 0o600 });
};

const callOf = (line: string, file: string): OpenerCall => {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed === 'object' && parsed !== null && 'program' in parsed && 'args' in parsed && typeof parsed.program === 'string' && Array.isArray(parsed.args)) {
    return { program: parsed.program, args: parsed.args.map(String) };
  }
  throw new Error(`the opener record ${file} holds a line that is not a call: ${line}`);
};

const textOfRecord = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
};

export const readOpenerRecord = (file: string): OpenerCall[] =>
  textOfRecord(file)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => callOf(line, file));
