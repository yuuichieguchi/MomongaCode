const statementsOf = (sql: string): string[] => {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  for (const line of sql.split('\n')) {
    current += `${line}\n`;
    if (/^\s*CREATE\s+TRIGGER\b/i.test(line)) depth += 1;
    if (depth > 0 && /\bEND\s*;\s*$/i.test(line)) depth -= 1;
    if (depth === 0 && /;\s*$/.test(line)) {
      statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements;
};

const addedColumnTables = (statements: readonly string[]): Set<string> =>
  new Set(statements.flatMap((statement) => {
    const match = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\b/i.exec(statement);
    return match?.[1] === undefined ? [] : [match[1].toLowerCase()];
  }));

const formViolationsOf = (statement: string, columnTables: ReadonlySet<string>): string[] => {
  const violations: string[] = [];
  const head = statement.split('\n')[0] ?? statement;
  if (/^DROP\s+/i.test(statement) && !/^DROP\s+TRIGGER\b/i.test(statement)) violations.push(`a DROP removes what the previous release reads: ${head}`);
  if (/^ALTER\s+TABLE\s+\w+\s+DROP\b/i.test(statement)) violations.push(`a DROP COLUMN removes what the previous release reads: ${head}`);
  if (/^ALTER\s+TABLE\s+\w+\s+RENAME\b/i.test(statement)) violations.push(`a RENAME breaks the previous release's statements: ${head}`);
  const addColumn = /^ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\b(.*)$/is.exec(statement);
  if (addColumn?.[1] !== undefined) {
    const definition = addColumn[1];
    if (/\bNOT\s+NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition)) violations.push(`a NOT NULL without a default column refuses the previous release's inserts: ${head}`);
    if (/\bCHECK\s*\(/i.test(definition)) violations.push(`a new CHECK on an existing table refuses writes of the previous release: ${head}`);
  }
  const trigger = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:INSERT|UPDATE|DELETE)(?:\s+OF\s+[\w\s,]+?)?\s+ON\s+(\w+)/is.exec(statement);
  if (trigger?.[1] !== undefined && /\bRAISE\s*\(\s*(?:ABORT|FAIL|ROLLBACK)\b/i.test(statement) && columnTables.has(trigger[1].toLowerCase())) {
    violations.push(`a tightening trigger ships with the column it requires, so the previous release cannot satisfy it: ${head}`);
  }
  return violations;
};

export const migrationFormViolations = (sql: string): string[] => {
  const statements = statementsOf(sql);
  const columnTables = addedColumnTables(statements);
  return statements.flatMap((statement) => formViolationsOf(statement, columnTables));
};
