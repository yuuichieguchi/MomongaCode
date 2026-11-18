import { execFileSync } from '@momonga/testkit/child-process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH } from '@momonga/sandbox';
import { TEST_SETUP_COMMAND, tlaJarPathOf } from '../../scripts/fetch-tla.ts';
import { SEA_TARGETS, archiveNameOf, nodeArchiveCacheDir } from '../../scripts/node-runtime.ts';
import { RIPGREP_TARGETS, ripgrepCacheDir } from '../../scripts/ripgrep-release.ts';

export type TestProject = 'unit' | 'e2e' | 'packaging' | 'calibration';

export type ToolHost = {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly exists: (file: string) => boolean;
  readonly versionOf: (file: string) => string | undefined;
  readonly sha256Of: (file: string) => string | undefined;
  readonly onPath: (program: string) => boolean;
};

export type RequiredTool = {
  readonly name: string;
  readonly path: string;
  readonly platforms: readonly NodeJS.Platform[];
  readonly projects: readonly TestProject[];
  readonly setup: string;
  readonly present: (host: ToolHost) => boolean;
  readonly appliesTo?: (host: ToolHost) => boolean;
};

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const COMPLIANCE_DIR = path.join(ROOT, 'compliance', 'open-responses');

const pinnedBunVersion = (): string => {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(COMPLIANCE_DIR, 'package.json'), 'utf8'));
  const dependencies = typeof manifest === 'object' && manifest !== null && 'dependencies' in manifest ? manifest.dependencies : undefined;
  const version = typeof dependencies === 'object' && dependencies !== null && 'bun' in dependencies ? dependencies.bun : undefined;
  if (typeof version !== 'string') throw new Error(`${COMPLIANCE_DIR}/package.json pins no bun version`);
  return version;
};

export const BUN_VERSION = pinnedBunVersion();

const POSIX: readonly NodeJS.Platform[] = ['darwin', 'linux'];

const file = (name: string, location: string, rest: Omit<RequiredTool, 'name' | 'path' | 'present'>): RequiredTool => ({ name, path: location, ...rest, present: (host) => host.exists(location) });

const pinnedArchive = (name: string, location: string, sha256: string, appliesTo?: (host: ToolHost) => boolean): RequiredTool => ({
  name,
  path: location,
  platforms: POSIX,
  projects: ['packaging'],
  setup: TEST_SETUP_COMMAND,
  present: (host) => host.sha256Of(location) === sha256,
  ...(appliesTo === undefined ? {} : { appliesTo }),
});

const BUN_PATH = path.join(COMPLIANCE_DIR, 'node_modules', '.bin', 'bun');

const buildsSingleExecutables = (host: ToolHost): boolean => host.platform === 'darwin' && host.arch === 'arm64';

export const REQUIRED_TOOLS: readonly RequiredTool[] = [
  {
    name: 'bun',
    path: BUN_PATH,
    platforms: POSIX,
    projects: ['e2e'],
    setup: TEST_SETUP_COMMAND,
    present: (host) => host.exists(BUN_PATH) && host.versionOf(BUN_PATH)?.trim() === BUN_VERSION,
  },
  file('bwrap', DEFAULT_BWRAP_PATH, { platforms: ['linux'], projects: ['unit', 'e2e'], setup: 'install bubblewrap (apt-get install bubblewrap)' }),
  file('openssl', '/usr/bin/openssl', { platforms: POSIX, projects: ['e2e'], setup: 'install openssl (apt-get install openssl); the fake https git server makes its certificate with it' }),
  file('python3', '/usr/bin/python3', { platforms: POSIX, projects: ['e2e'], setup: 'install python3 (apt-get install python3; on macOS xcode-select --install); the pseudo-terminal host of the TUI tests runs on it' }),
  file('ps', '/bin/ps', { platforms: POSIX, projects: ['e2e'], setup: 'install procps (apt-get install procps)' }),
  { name: 'git', path: 'git on PATH', platforms: POSIX, projects: ['e2e'], setup: 'install git (apt-get install git) and put it on PATH', present: (host) => host.onPath('git') },
  file('sandbox-exec', DEFAULT_SANDBOX_EXEC_PATH, { platforms: ['darwin'], projects: ['unit', 'e2e'], setup: 'macOS ships sandbox-exec; a host without it cannot run these tests' }),
  file('tla2tools.jar', tlaJarPathOf(ROOT), { platforms: POSIX, projects: ['packaging'], setup: TEST_SETUP_COMMAND }),
  { name: 'zig', path: 'zig on PATH', platforms: POSIX, projects: ['packaging'], setup: 'install zig (https://ziglang.org/download/) and put it on PATH', present: (host) => host.onPath('zig') },
  ...Object.values(SEA_TARGETS).map((target) => pinnedArchive(archiveNameOf(target), path.join(nodeArchiveCacheDir, archiveNameOf(target)), target.archiveSha256, buildsSingleExecutables)),
  ...Object.values(RIPGREP_TARGETS).map((row) => pinnedArchive(row.archiveName, path.join(ripgrepCacheDir, row.archiveName), row.archiveSha256)),
];

const versionOf = (program: string): string | undefined => {
  try {
    return execFileSync(program, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};

const sha256Of = (location: string): string | undefined => (fs.existsSync(location) ? createHash('sha256').update(fs.readFileSync(location)).digest('hex') : undefined);

const onPath = (program: string): boolean =>
  (process.env['PATH'] ?? '').split(path.delimiter).some((directory) => directory !== '' && fs.existsSync(path.join(directory, program)));

export const HOST: ToolHost = { platform: process.platform, arch: process.arch, exists: (location) => fs.existsSync(location), versionOf, sha256Of, onPath };

const toolNamed = (name: string): RequiredTool => {
  const tool = REQUIRED_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no required tool is named ${name}`);
  return tool;
};

const missingMessage = (tool: RequiredTool, platform: NodeJS.Platform): string => `${tool.name} is required on ${platform} and is missing or unusable at ${tool.path}; run: ${tool.setup}`;

const applies = (tool: RequiredTool, host: ToolHost): boolean => tool.platforms.includes(host.platform) && (tool.appliesTo === undefined || tool.appliesTo(host));

export const requiredToolPath = (name: string): string => toolNamed(name).path;

export const requires = (name: string, host: ToolHost = HOST): void => {
  const tool = toolNamed(name);
  if (applies(tool, host) && !tool.present(host)) throw new Error(missingMessage(tool, host.platform));
};

export const missingToolsOf = (project: TestProject, host: ToolHost = HOST): RequiredTool[] =>
  REQUIRED_TOOLS.filter((tool) => tool.projects.includes(project) && applies(tool, host) && !tool.present(host));

const refusalOf = (message: string): Error => {
  const refusal = new Error(message);
  refusal.stack = `${refusal.name}: ${refusal.message}`;
  return refusal;
};

export const checkRequiredTools = (project: TestProject, host: ToolHost = HOST): void => {
  const missing = missingToolsOf(project, host);
  if (missing.length > 0) throw refusalOf(missing.map((tool) => missingMessage(tool, host.platform)).join('\n'));
};

const PROJECTS: readonly TestProject[] = ['unit', 'e2e', 'packaging', 'calibration'];

const isTestProject = (name: string): name is TestProject => PROJECTS.some((project) => project === name);

export const setupWith = (project: { readonly name: string }, host: ToolHost): void => {
  if (!isTestProject(project.name)) throw refusalOf(`the required tools know no test project named ${project.name}`);
  checkRequiredTools(project.name, host);
};

export default function setup(project: { readonly name: string }): void {
  setupWith(project, HOST);
}
