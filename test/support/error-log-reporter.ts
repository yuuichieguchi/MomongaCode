import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, SerializedError, TestCase, TestModule } from 'vitest/node';

export const ERROR_LOG_ENV = 'MOMONGA_TEST_ERROR_LOG';

const SEPARATOR = '---\n';

const relativePath = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

const formatError = (error: SerializedError): string => {
  if (typeof error.stack === 'string' && error.stack.trim() !== '') return error.stack.trimEnd();
  const header = error.name ? `${error.name}: ${error.message ?? ''}` : (error.message ?? String(error));
  return header.trimEnd();
};

const formatErrors = (errors: readonly SerializedError[]): string =>
  errors.length === 0 ? '(no error details)' : errors.map(formatError).join('\n\n');

export const formatFailedTestCase = (testCase: TestCase, root: string): string => {
  const result = testCase.result();
  const file = relativePath(root, testCase.module.moduleId);
  const line = testCase.location?.line;
  const where = line === undefined ? file : `${file}:${line}`;
  const project = testCase.project.name;
  const details = result.state === 'failed' ? formatErrors(result.errors) : '(not failed)';
  return `FAIL [${project}] ${where} > ${testCase.fullName}\n${details}\n${SEPARATOR}`;
};

export const formatFailedModule = (testModule: TestModule, root: string): string => {
  const file = relativePath(root, testModule.moduleId);
  const project = testModule.project.name;
  return `FAIL [${project}] ${file} (module error)\n${formatErrors(testModule.errors())}\n${SEPARATOR}`;
};

export const formatUnhandledErrors = (errors: readonly SerializedError[]): string =>
  `FAIL [unhandled]\n${formatErrors(errors)}\n${SEPARATOR}`;

export const errorLogPathOf = (env: NodeJS.ProcessEnv): string | undefined => {
  const raw = env[ERROR_LOG_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : path.resolve(trimmed);
};

export default class ErrorLogReporter implements Reporter {
  private readonly env: NodeJS.ProcessEnv;
  private root = process.cwd();
  private logPath: string | undefined;

  constructor(options?: { readonly env?: NodeJS.ProcessEnv }) {
    this.env = options?.env ?? process.env;
  }

  onInit(vitest: { readonly config: { readonly root: string } }): void {
    this.root = vitest.config.root;
    this.logPath = errorLogPathOf(this.env);
    if (this.logPath === undefined) return;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.writeFileSync(this.logPath, '', 'utf8');
  }

  onTestCaseResult(testCase: TestCase): void {
    if (this.logPath === undefined) return;
    if (testCase.result().state !== 'failed') return;
    fs.appendFileSync(this.logPath, formatFailedTestCase(testCase, this.root), 'utf8');
  }

  onTestModuleEnd(testModule: TestModule): void {
    if (this.logPath === undefined) return;
    if (testModule.errors().length === 0) return;
    fs.appendFileSync(this.logPath, formatFailedModule(testModule, this.root), 'utf8');
  }

  onTestRunEnd(_modules: readonly TestModule[], unhandledErrors: readonly SerializedError[]): void {
    if (this.logPath === undefined) return;
    if (unhandledErrors.length === 0) return;
    fs.appendFileSync(this.logPath, formatUnhandledErrors(unhandledErrors), 'utf8');
  }
}
