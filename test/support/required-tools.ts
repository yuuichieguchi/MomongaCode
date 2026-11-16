import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH } from '@momonga/sandbox';

export type TestProject = 'unit' | 'e2e' | 'packaging' | 'calibration';

export type RequiredTool = {
  readonly name: string;
  readonly path: string;
  readonly platforms: readonly NodeJS.Platform[];
  readonly projects: readonly TestProject[];
  readonly setup: string;
};

export type ToolHost = { readonly exists: (file: string) => boolean; readonly platform: NodeJS.Platform };

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export const REQUIRED_TOOLS: readonly RequiredTool[] = [
  { name: 'bun', path: path.join(ROOT, 'compliance', 'open-responses', 'node_modules', '.bin', 'bun'), platforms: ['darwin', 'linux'], projects: [], setup: 'npm ci --prefix compliance/open-responses' },
  { name: 'bwrap', path: DEFAULT_BWRAP_PATH, platforms: ['linux'], projects: ['unit', 'e2e'], setup: 'install bubblewrap (apt-get install bubblewrap)' },
  { name: 'openssl', path: '/usr/bin/openssl', platforms: ['darwin', 'linux'], projects: ['e2e'], setup: 'install openssl (apt-get install openssl); the fake https git server makes its certificate with it' },
  { name: 'sandbox-exec', path: DEFAULT_SANDBOX_EXEC_PATH, platforms: ['darwin'], projects: ['unit', 'e2e'], setup: 'macOS ships sandbox-exec; a host without it cannot run these tests' },
];

export const HOST: ToolHost = { exists: (file) => fs.existsSync(file), platform: process.platform };

const toolNamed = (name: string): RequiredTool => {
  const tool = REQUIRED_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no required tool is named ${name}`);
  return tool;
};

const missingMessage = (tool: RequiredTool, platform: NodeJS.Platform): string => `${tool.name} is required on ${platform} and is missing at ${tool.path}; run: ${tool.setup}`;

export const requiredToolPath = (name: string): string => toolNamed(name).path;

export const requires = (name: string, host: ToolHost = HOST): void => {
  const tool = toolNamed(name);
  if (tool.platforms.includes(host.platform) && !host.exists(tool.path)) throw new Error(missingMessage(tool, host.platform));
};

export const missingToolsOf = (project: TestProject, host: ToolHost = HOST): RequiredTool[] =>
  REQUIRED_TOOLS.filter((tool) => tool.projects.includes(project) && tool.platforms.includes(host.platform) && !host.exists(tool.path));

export const checkRequiredTools = (project: TestProject, host: ToolHost = HOST): void => {
  const missing = missingToolsOf(project, host);
  if (missing.length > 0) throw new Error(missing.map((tool) => missingMessage(tool, host.platform)).join('\n'));
};

const PROJECTS: readonly TestProject[] = ['unit', 'e2e', 'packaging', 'calibration'];

const isTestProject = (name: string): name is TestProject => PROJECTS.some((project) => project === name);

export default function setup(project: { readonly name: string }): void {
  if (!isTestProject(project.name)) throw new Error(`the required tools know no test project named ${project.name}`);
  checkRequiredTools(project.name);
}
