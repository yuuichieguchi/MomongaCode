import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_PATH = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla', 'manifest.json');

type Row = Readonly<Record<string, unknown>>;

const rowsOf = (manifestPath: string, key: string): Row[] => {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !(key in parsed)) throw new Error(`${manifestPath} has no ${key}`);
  const rows: unknown = (parsed as Row)[key];
  if (!Array.isArray(rows) || rows.some((row) => typeof row !== 'object' || row === null)) throw new Error(`${manifestPath}: ${key} is not a list of objects`);
  return rows as Row[];
};

const budgetOf = (rows: readonly Row[], field: string, name: string): number | undefined => {
  const row = rows.find((candidate) => candidate[field] === name);
  if (row === undefined) return undefined;
  const budget = row['budgetCpuSeconds'];
  if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget <= 0) throw new Error(`the budgetCpuSeconds of ${name} is not a whole number above 0`);
  return budget;
};

export const tlcRowBudgetOf = (config: string, manifestPath: string = MANIFEST_PATH): number | undefined => budgetOf(rowsOf(manifestPath, 'entries'), 'config', config);

export const vitestProjectBudgetOf = (project: string, manifestPath: string = MANIFEST_PATH): number | undefined => budgetOf(rowsOf(manifestPath, 'vitestProjects'), 'project', project);

if (import.meta.main) {
  const [config] = process.argv.slice(2);
  if (config === undefined) throw new Error('usage: node scripts/support/run-budgets.ts <tlc-config>');
  const budget = tlcRowBudgetOf(config);
  if (budget !== undefined) process.stdout.write(`${budget}\n`);
}
