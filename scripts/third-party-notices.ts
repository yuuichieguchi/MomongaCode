import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { bundleInputsOf, defaultEntry, journalThreadEntry, repoRoot, ruleVerifierThreadEntry } from './bundle.ts';
import type { BundleInputs } from './bundle.ts';
import { SEA_NODE_VERSION } from './node-runtime.ts';
import { RIPGREP_LICENCE_FILES, RIPGREP_TARGETS, RIPGREP_VERSION, ripgrepCacheDir } from './ripgrep-release.ts';
import { hostSeaTarget, nodeCacheDir } from './sea.ts';
import { z3BuildDirectory } from './z3-assets.ts';

export type NoticeText = { readonly file: string; readonly text: string };

export type NoticeComponent = {
  readonly name: string;
  readonly version: string;
  readonly licence: string;
  readonly texts: readonly NoticeText[];
  readonly where?: string;
};

export type NoticeSources = {
  readonly root: string;
  readonly bundleEntries: readonly string[];
  readonly z3Entry: string;
  readonly recordedLicences: string;
  readonly nodeDirectory: string;
  readonly ripgrepDirectory: string;
  readonly mingwDirectory: string;
  readonly zigVersion: string;
};

export const NOTICES_FILE = `${repoRoot}THIRD-PARTY-NOTICES.md`;
export const RECORDED_LICENCES_DIRECTORY = `${repoRoot}scripts/third-party-licences`;

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

type PackageManifest = { readonly name?: unknown; readonly version?: unknown; readonly license?: unknown };

const manifestOf = (directory: string): PackageManifest => {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${path.join(directory, 'package.json')} is not a JSON object`);
  return parsed;
};

const textField = (manifest: PackageManifest, field: 'name' | 'version' | 'license', directory: string): string => {
  const value = manifest[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path.join(directory, 'package.json')} has no ${field}`);
  return value;
};

const namedPackageDirectoryOf = (file: string, root: string): string => {
  let directory = path.dirname(file);
  while (directory.startsWith(root)) {
    if (fs.existsSync(path.join(directory, 'package.json')) && manifestOf(directory).name !== undefined) return directory;
    directory = path.dirname(directory);
  }
  throw new Error(`${file} belongs to no package under ${root}`);
};

export const thirdPartyPackagesOf = (inputsList: readonly BundleInputs[], root: string): string[] => {
  const directories = new Set<string>();
  for (const inputs of inputsList) {
    for (const input of Object.keys(inputs)) {
      if (input.startsWith('<')) continue;
      directories.add(namedPackageDirectoryOf(path.resolve(root, input), path.resolve(root)));
    }
  }
  return [...directories].filter((directory) => manifestOf(directory).license !== undefined).sort();
};

const recordedFileName = (name: string, version: string): string => `${name.replaceAll('/', '__')}@${version}.txt`;

export const componentOfPackage = (directory: string, recordedLicences: string): NoticeComponent => {
  const manifest = manifestOf(directory);
  const name = textField(manifest, 'name', directory);
  const version = textField(manifest, 'version', directory);
  const licence = textField(manifest, 'license', directory);
  const shipped = fs
    .readdirSync(directory)
    .filter((entry) => LICENCE_FILE.test(entry) && fs.statSync(path.join(directory, entry)).isFile())
    .sort();
  const recorded = path.join(recordedLicences, recordedFileName(name, version));
  const hasRecorded = fs.existsSync(recorded);
  if (shipped.length > 0 && hasRecorded) throw new Error(`${name}@${version} ships its licence file, so the recorded copy ${recorded} must be removed`);
  if (shipped.length > 0) return { name, version, licence, texts: shipped.map((file) => ({ file, text: fs.readFileSync(path.join(directory, file), 'utf8') })) };
  if (!hasRecorded) throw new Error(`${name}@${version} (${directory}) ships no licence file, and ${recorded} does not exist`);
  return { name, version, licence, texts: [{ file: path.basename(recorded), text: fs.readFileSync(recorded, 'utf8') }] };
};

const z3BundleInputsOf = async (z3Entry: string, root: string): Promise<BundleInputs> => {
  const result = await build({
    entryPoints: [z3Entry],
    absWorkingDir: root,
    outfile: `${root}.cache/z3-inputs/api.js`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['./z3-built'],
    write: false,
    metafile: true,
    logLevel: 'error',
  });
  return result.metafile.inputs;
};

const textsOf = (directory: string, files: readonly string[]): NoticeText[] => files.map((file) => ({ file, text: fs.readFileSync(path.join(directory, file), 'utf8') }));

const nativeComponents = (sources: NoticeSources): NoticeComponent[] => [
  {
    name: 'Node.js',
    version: SEA_NODE_VERSION,
    licence: 'MIT; its LICENSE also carries the licences of the components Node.js contains (V8, OpenSSL, ICU, libuv and the others it lists)',
    texts: textsOf(sources.nodeDirectory, ['LICENSE']),
    where: 'The Node.js runtime is the base of the single executable.',
  },
  {
    name: 'ripgrep',
    version: RIPGREP_VERSION,
    licence: 'Unlicense OR MIT',
    texts: textsOf(sources.ripgrepDirectory, RIPGREP_LICENCE_FILES),
    where:
      'The official release binaries, pinned by sha256 in `scripts/ripgrep-release.ts`. The same texts are embedded in the executable and written as `NOTICE.txt` beside the extracted `rg`, in `executables/ripgrep-<version>-<hash>/` under the Momonga Code cache directory.',
  },
  {
    name: 'mingw-w64 runtime',
    version: `of zig ${sources.zigVersion}`,
    licence: 'Zope Public License 2.1, with the parts its COPYING marks as public domain, BSD or LGPL',
    texts: textsOf(sources.mingwDirectory, ['COPYING']),
    where: 'Linked by `zig cc` into `momonga-keeper.exe`, which only the Windows executable contains.',
  },
];

const fenceFor = (text: string): string => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));

const sectionOf = (component: NoticeComponent): string => {
  const lines = [`## ${component.name} ${component.version}`, '', `- Licence: ${component.licence}.`];
  if (component.where !== undefined) lines.push(`- ${component.where}`);
  for (const { file, text } of component.texts) {
    const fence = fenceFor(text);
    lines.push('', `${file}:`, '', `${fence}text`, text.replace(/\n+$/, ''), fence);
  }
  return lines.join('\n');
};

export const renderNotices = (components: readonly NoticeComponent[]): string =>
  [
    '# Third-party notices',
    '',
    'The Momonga Code executables embed the third-party components listed here, each with its version, its licence and its full notice text. This file is generated from the build\'s inputs by `npm run notices`; it is not edited by hand.',
    ...components.map((component) => `\n${sectionOf(component)}`),
    '',
  ].join('\n');

const packageKey = (component: NoticeComponent): string => `${component.name}@${component.version}`;

export const generateNotices = async (sources: NoticeSources): Promise<string> => {
  const inputs = await Promise.all(sources.bundleEntries.map((entry) => bundleInputsOf(entry)));
  inputs.push(await z3BundleInputsOf(sources.z3Entry, sources.root));
  const packages = new Map<string, NoticeComponent>();
  for (const directory of thirdPartyPackagesOf(inputs, sources.root)) {
    const component = componentOfPackage(directory, sources.recordedLicences);
    if (!packages.has(packageKey(component))) packages.set(packageKey(component), component);
  }
  const ordered = [...packages.values()].sort((left, right) => (packageKey(left) < packageKey(right) ? -1 : packageKey(left) > packageKey(right) ? 1 : 0));
  return renderNotices([...nativeComponents(sources), ...ordered]);
};

const zigEnvironmentField = (environment: string, field: string): string => {
  const value = new RegExp(`\\.${field} = "([^"]*)"`).exec(environment)?.[1];
  if (value === undefined) throw new Error(`zig env does not report .${field}`);
  return value;
};

export const hostNoticeSources = (): NoticeSources => {
  const target = hostSeaTarget();
  const zigEnvironment = execFileSync('zig', ['env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return {
    root: repoRoot,
    bundleEntries: [defaultEntry, journalThreadEntry, ruleVerifierThreadEntry],
    z3Entry: path.join(z3BuildDirectory(import.meta.url), 'node.js'),
    recordedLicences: RECORDED_LICENCES_DIRECTORY,
    nodeDirectory: path.join(nodeCacheDir, `node-v${SEA_NODE_VERSION}-${target}`),
    ripgrepDirectory: path.join(ripgrepCacheDir, path.dirname(RIPGREP_TARGETS[target].memberPath)),
    mingwDirectory: path.join(zigEnvironmentField(zigEnvironment, 'lib_dir'), 'libc', 'mingw'),
    zigVersion: zigEnvironmentField(zigEnvironment, 'version'),
  };
};

if (import.meta.main) {
  const { values } = parseArgs({ options: { output: { type: 'string', default: NOTICES_FILE } } });
  fs.writeFileSync(values.output, await generateNotices(hostNoticeSources()));
}
