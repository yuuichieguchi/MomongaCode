import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_VALUE_CHECK_TEST_TIMEOUT_MS, itWithDocuments } from '@momonga/testkit';
import { checkRows, constantRowsOf, parseValueCell } from './support/constants-rows.ts';

vi.setConfig({ testTimeout: DOCUMENT_VALUE_CHECK_TEST_TIMEOUT_MS });

const CONSTANTS_DOCUMENT_VARIABLE = 'MOMONGA_CONSTANTS_DOCUMENT';

const FIXTURE = [
  '# Fixture',
  '',
  '| Name | Value | Reason |',
  '|---|---|---|',
  '| `POLL_INTERVAL_MS` | `25` | a poll |',
  '| `KILL_CONFIRM_MS` | 5 s | the confirmation |',
  '| `managedServerStopBoundMs(0)` | 10075 ms (the fixed terms) | a bound |',
  '| `gatewayMaxCloseMs(DEFAULT_STOP_VALUES)` | 32075 ms | at the defaults |',
  '| `POLL_INTERVAL_MS` | 26 | drifted |',
  '| `NO_SUCH_CONSTANT_ANYWHERE` | 1 | gone |',
  '| `OLD_MARGIN_MS` | unchecked: removed | deleted |',
  '| `LOCK_FD` | five | prose |',
  "| `KILL_WAIT_MS` (`packages/cli/src/daemon/generations.ts`) | 5 s | a module-private constant read from its named file |",
  '| `KILL_WAIT_MS` | 5000 | the same constant, its file not named |',
  '| `defaultContextSettings().autoCompact` | true | a property of a call |',
  '| `stopWaitBoundMs([5000, 9000])` (`packages/foundation/src/process-contract.ts`) | 9000 ms | a call with a JSON argument |',
  '| `UNREADABLE_CODES` (`packages/skills/src/file-system.ts`) | `EACCES`, `EPERM`, `ELOOP`, `ENAMETOOLONG` | a set read as a list |',
  '| `DEFAULT_PROBE_STEP_SECONDS` | 120 s | a constant in seconds |',
  '| `updateSourceDefines({})` (`scripts/bundle.ts`) | 1 | a call of a script function |',
  '| `stopWaitBoundMs(daemonStopBoundMs)` (`packages/foundation/src/process-contract.ts`) | 1 | a function as an argument |',
  '| `managedServerStopBoundMs(KILL_WAIT_MS)` (`packages/foundation/src/process-contract.ts`, `packages/cli/src/daemon/generations.ts`) | 1 | a private constant as an argument |',
  '| `E2E_READY_DEADLINE_MS` (`e2e/support/wait.ts`) | 1 | a test constant that calls a function of its own file |',
  '',
  '| Path | Form |',
  '|---|---|',
  '| `/x` | not a constants table |',
].join('\n');

describe('the value of every constants row is the value of the code', () => {
  it('reads the rows of the tables whose header names a Name and a Value', () => {
    expect(constantRowsOf('fixture.md', FIXTURE).map((row) => row.name)).toEqual([
      'POLL_INTERVAL_MS',
      'KILL_CONFIRM_MS',
      'managedServerStopBoundMs(0)',
      'gatewayMaxCloseMs(DEFAULT_STOP_VALUES)',
      'POLL_INTERVAL_MS',
      'NO_SUCH_CONSTANT_ANYWHERE',
      'OLD_MARGIN_MS',
      'LOCK_FD',
      'KILL_WAIT_MS',
      'KILL_WAIT_MS',
      'defaultContextSettings().autoCompact',
      'stopWaitBoundMs([5000, 9000])',
      'UNREADABLE_CODES',
      'DEFAULT_PROBE_STEP_SECONDS',
      'updateSourceDefines({})',
      'stopWaitBoundMs(daemonStopBoundMs)',
      'managedServerStopBoundMs(KILL_WAIT_MS)',
      'E2E_READY_DEADLINE_MS',
    ]);
  });

  it('parses a value with its unit into the base unit, and recognises only the explicit unchecked mark', () => {
    expect(parseValueCell('`1048576`')).toEqual({ kind: 'value', value: 1048576 });
    expect(parseValueCell('1,048,576 (1 MiB)')).toEqual({ kind: 'value', value: 1048576 });
    expect(parseValueCell('64 MiB')).toEqual({ kind: 'value', value: 64 * 1024 * 1024 });
    expect(parseValueCell('7 days')).toEqual({ kind: 'value', value: 7 * 86_400_000 });
    expect(parseValueCell('120 s')).toEqual({ kind: 'value', value: 120_000 });
    expect(parseValueCell('0x20')).toEqual({ kind: 'value', value: 32 });
    expect(parseValueCell('8.64e15')).toEqual({ kind: 'value', value: 8.64e15 });
    expect(parseValueCell('true')).toEqual({ kind: 'value', value: true });
    expect(parseValueCell('`/dev/null`')).toEqual({ kind: 'value', value: '/dev/null' });
    expect(parseValueCell("`'seatbelt-profile'`")).toEqual({ kind: 'value', value: 'seatbelt-profile' });
    expect(parseValueCell('64 tokens')).toEqual({ kind: 'value', value: 64 });
    expect(parseValueCell('`MAX_RUN_TIMEOUT_MS`')).toEqual({ kind: 'reference', name: 'MAX_RUN_TIMEOUT_MS' });
    expect(parseValueCell('unchecked: removed with the pid file')).toEqual({ kind: 'unchecked', reason: 'removed with the pid file' });
    expect(parseValueCell('removed')).toEqual({ kind: 'unreadable' });
    expect(parseValueCell('no default')).toEqual({ kind: 'unreadable' });
  });

  it('checks each row against the export of the product, and fails a drifted value, a name that resolves to nothing and an unmarked prose value', async () => {
    const outcome = await checkRows(constantRowsOf('fixture.md', FIXTURE));
    expect(outcome.checked).toBe(9);
    expect(outcome.unchecked).toBe(1);
    expect(outcome.failures.map((failure) => [failure.row.name, failure.reason])).toEqual([
      ['POLL_INTERVAL_MS', 'the document says 26, the code says 25'],
      ['NO_SUCH_CONSTANT_ANYWHERE', 'NO_SUCH_CONSTANT_ANYWHERE is declared at the top level of no product module'],
      ['LOCK_FD', 'the value "five" is not a checkable value; write the value, or mark the row `unchecked: <reason>`'],
      ['KILL_WAIT_MS', 'KILL_WAIT_MS is a constant of packages/cli/src/daemon/generations.ts (not exported) only: name that file in the row'],
      ['updateSourceDefines({})', 'updateSourceDefines of scripts/bundle.ts is not exported by a product package (packages/*/src), so it is not called'],
      ['stopWaitBoundMs(daemonStopBoundMs)', 'the argument daemonStopBoundMs is a function; an argument is a literal or an exported constant'],
      ['managedServerStopBoundMs(KILL_WAIT_MS)', 'KILL_WAIT_MS of packages/cli/src/daemon/generations.ts is not exported by a product package (packages/*/src), so it is not used as an argument'],
      ['E2E_READY_DEADLINE_MS', 'the value of E2E_READY_DEADLINE_MS in e2e/support/wait.ts calls a function that is not exported by a product package; it is not run'],
    ]);
  });

  const rowsTitle = `finds every row of the constants documents in the folder named by ${CONSTANTS_DOCUMENT_VARIABLE} equal to the code, or marked unchecked`;
  itWithDocuments(CONSTANTS_DOCUMENT_VARIABLE, import.meta.dirname, rowsTitle, async (directory) => {
    const rows = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .flatMap((name) => constantRowsOf(name, fs.readFileSync(path.join(directory, name), 'utf8')));
    const outcome = await checkRows(rows);
    const failures = outcome.failures.map((failure) => `${failure.row.file}:${failure.row.line} ${failure.row.name}: ${failure.reason}`);
    expect({ checked: outcome.checked, unchecked: outcome.unchecked, failures }).toEqual({ checked: outcome.checked, unchecked: outcome.unchecked, failures: [] });
  });
});
