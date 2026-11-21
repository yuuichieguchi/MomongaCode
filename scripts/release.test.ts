import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIGNATURE_REJECTED_EXIT_CODE } from '@momonga/foundation';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';
import { createTempDir } from '@momonga/testkit';

const STUB_SOURCES: Record<string, string> = {
  npm: `case " $* " in *" \${STUB_NPM_FAIL:-no-such-script} "*) exit 1 ;; esac
output=""
target="darwin-arm64"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then output="$2"; fi
  if [ "$1" = "--target" ]; then target="$2"; fi
  shift
done
if [ -n "$output" ]; then
  case "$output" in
    *.exe) printf 'MZ stub' > "$output" ;;
    *linux*) if [ "\${STUB_LINUX_NOT_ELF:-0}" = "1" ]; then printf 'not elf' > "$output"; else printf '\\177ELF stub' > "$output"; fi ;;
    *) printf '#!/bin/sh\\necho "%s"\\nexit 0\\n' "\${STUB_BINARY_VERSION:-1.2.3}" > "$output" ;;
  esac
  embedded="\${STUB_RIPGREP_TARGET:-$target}"
  printf '{"version":"%s","target":"%s","binary":{"asset":"ripgrep.br","sha256":"%s","size":1,"name":"rg"},"notices":{"asset":"ripgrep-notices.txt","sha256":"%s"}}\\n' "\${STUB_RIPGREP_VERSION:-15.2.0}" "$embedded" "$(printf 'a%.0s' $(seq 64))" "$(printf 'b%.0s' $(seq 64))" >> "$output"
  chmod 755 "$output"
fi`,
  ditto: `for last; do :; done
: > "$last"`,
  xcrun: `if [ "$1" = "notarytool" ] && [ "$2" = "log" ]; then
  if [ "\${STUB_NOTARY_LOG_EXIT:-0}" != "0" ]; then exit "\${STUB_NOTARY_LOG_EXIT}"; fi
  printf '{"status":"%s","ticketContents":[{"path":"momonga-darwin-arm64.zip/release/momonga-darwin-arm64","digestAlgorithm":"SHA-256","cdhash":"%s","arch":"arm64"}]}\\n' "\${STUB_NOTARY_LOG_STATUS:-Accepted}" "\${STUB_NOTARY_CDHASH:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
else
  printf '{"id":"fake-submission","status":"%s"}\\n' "\${STUB_NOTARY_STATUS:-Accepted}"
  i=0; while [ "$i" -lt "\${STUB_NOTARY_PADDING_LINES:-0}" ]; do echo 'padding line of a long notary log'; i=$((i + 1)); done
fi`,
  zig: '',
  npx: `exit "\${STUB_SMOKE_EXIT:-0}"`,
  docker: `if [ "$1" = "info" ]; then exit "\${STUB_DOCKER_INFO_EXIT:-0}"; fi
cat > /dev/null
echo "EXIT=\${STUB_CONTAINER_SMOKE_EXIT:-0}"`,
  codesign: `if [ "$1" = "--display" ]; then printf 'Authority=Developer ID\\nTeamIdentifier=%s\\nCDHash=%s\\n' "\${STUB_TEAM_ID:-PQQBSRKD72}" "\${STUB_CDHASH:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" >&2; i=0; while [ "$i" -lt "\${STUB_DISPLAY_PADDING_LINES:-0}" ]; do echo 'padding line of a long codesign display' >&2; i=$((i + 1)); done; fi`,
  'ssh-keygen': `case " $* " in *" verify "*)
  signers=''
  while [ $# -gt 0 ]; do if [ "$1" = -f ]; then signers=$2; fi; shift; done
  if [ -n "\${STUB_SSH_REJECT_KEY:-}" ] && ! grep -qF "$STUB_SSH_REJECT_KEY" "$signers"; then exit 0; fi
  exit "\${STUB_SSH_VERIFY_EXIT:-0}" ;; esac
for last; do :; done
printf 'signature' > "$last.sig"`,
  gh: `case "$1 $2" in
  "release edit")
    if [ "\${STUB_GH_FAIL_ON:-}" = "edit" ]; then exit 1; fi
    /usr/bin/git --git-dir "$STUB_ORIGIN" tag "$3" "$(/usr/bin/git --git-dir "$STUB_ORIGIN" rev-parse refs/heads/main)" ;;
  "release create")
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--notes-file" ]; then cp "$arg" "$(dirname "$STUB_LOG")/gh-release-notes.txt"; fi
      prev="$arg"
    done
    if [ "\${STUB_GH_FAIL_ON:-}" = "create" ]; then exit 1; fi ;;
esac`,
  curl: `out=''
headers=''
format=''
head=0
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o | --output) out="$2"; shift ;;
    -D | --dump-header) headers="$2"; shift ;;
    -w | --write-out) format="$2"; shift ;;
    -I | --head) head=1 ;;
    -m | --max-time | --connect-timeout | --retry | --retry-delay | --retry-max-time | -H | --header | -A | --user-agent) shift ;;
    http://* | https://*) url="$1" ;;
    -[!-]?*)
      cluster="\${1#-}"
      last="\${cluster#"\${cluster%?}"}"
      case "$cluster" in *I*) head=1 ;; esac
      case "$last" in
        o) out="$2"; shift ;;
        D) headers="$2"; shift ;;
        w) format="$2"; shift ;;
        m | H | A) shift ;;
      esac ;;
  esac
  shift
done
case "$url" in
  https://momongacode.com/install.sh | https://momongacode.com/install.ps1) ;;
  *) exit 6 ;;
esac
file="\${url##*/}"
counter="$(dirname "$STUB_LOG")/curl-fetches-$file"
fetches=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$fetches" > "$counter"
type="\${STUB_CURL_TYPE:-text/plain; charset=utf-8}"
response="$(printf 'HTTP/2 200\\r\\ncontent-type: %s\\r\\n\\r\\n' "$type")"
if [ -n "$headers" ]; then printf '%s' "$response" > "$headers"; fi
if [ "$head" = "1" ]; then
  if [ -n "$out" ]; then printf '%s' "$response" > "$out"; else printf '%s' "$response"; fi
elif [ "\${STUB_CURL_BYTES:-built}" = "other" ] || [ "$fetches" -le "\${STUB_CURL_STALE_FETCHES:-0}" ]; then
  if [ -n "$out" ]; then printf 'not the built installer\\n' > "$out"; else printf 'not the built installer\\n'; fi
else
  if [ -n "$out" ]; then cat "$STUB_WORK/scripts/$file" > "$out"; else cat "$STUB_WORK/scripts/$file"; fi
fi
if [ -n "$format" ]; then
  written="$(printf '%s' "$format" | sed "s|%{content_type}|$type|g; s|%{http_code}|200|g; s|%{response_code}|200|g")"
  printf '%b' "$written"
fi`,
};

const FAKE_SITE_BUILD = `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, \`site \${args.map((arg) => \`\${arg} \`).join('')}\\n\`);
if (process.env.STUB_SITE_FAIL === '1') process.exit(1);
const root = path.resolve(import.meta.dirname, '..');
const at = args.indexOf('--output');
const output = path.resolve(at === -1 ? path.join(root, 'dist/site') : args[at + 1]);
fs.mkdirSync(output, { recursive: true });
for (const file of ['install.sh', 'install.ps1']) fs.copyFileSync(path.join(root, 'scripts', file), path.join(output, file));
`;

const SITE_DEPLOY_FAILED = 'the release v1.2.3 is published but momongacode.com was not updated: run scripts/site-deploy.sh again';
const siteBranchNotMoved = (commit: string): string =>
  `site-deploy.sh: the branch site of origin could not be moved to ${commit}: check that origin is reachable and that its branch site is not ahead of or diverged from ${commit}, then run scripts/site-deploy.sh again`;
const ORIGIN_AHEAD_OF_RELEASE = 'release.sh: main of origin has commits that HEAD does not have; pull (or rebase) first, then run scripts/release.sh again; nothing was built\n';
const RELEASE_PUSH_FAILED = 'release.sh: main could not be pushed to origin; check that origin is reachable and that its main is not ahead of or diverged from HEAD, then run scripts/release.sh again; nothing was published\n';
const ORIGIN_AHEAD_OF_DEPLOY = 'site-deploy.sh: main of origin has commits that HEAD does not have; pull (or rebase) first, then run scripts/site-deploy.sh again; nothing was deployed\n';
const NOT_ON_ORIGIN_MAIN = 'site-deploy.sh: HEAD is not a commit of main on origin and main is not checked out; check out main, or a commit origin has on main, then run scripts/site-deploy.sh again; nothing was deployed\n';
const SITE_URLS = ['https://momongacode.com/install.sh', 'https://momongacode.com/install.ps1'];

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Release Test',
  GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
  GIT_COMMITTER_NAME: 'Release Test',
  GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
});

const PINNED_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

const EMBEDDED_REPO = 'fake-owner/fake-repo';
const SIGNING_IDENTITY = 'Developer ID Application: Yuuichi Eguchi (PQQBSRKD72)';
const TEAM_ID = 'PQQBSRKD72';

const installers = (key: string, shellRepo = EMBEDDED_REPO, powershellRepo = shellRepo): Record<string, string> => ({
  'scripts/install.sh': `#!/bin/bash\nreadonly EMBEDDED_RELEASE_PUBLIC_KEY="${key}"\nreadonly EMBEDDED_RELEASE_REPO="${shellRepo}"\n`,
  'scripts/install.ps1': `$embeddedReleasePublicKey = '${key}'\n$embeddedReleaseRepo = '${powershellRepo}'\n`,
});

const CHECKS = ['docker', 'npm', 'npm'];
const BUILT = [...CHECKS, 'npm'];

describe.skipIf(!HAS_POSIX_SHELL)('release.sh', () => {
  let root = '';
  let stubs = '';
  let work = '';
  let origin = '';
  let log = '';
  let keyFile = '';
  let home = '';
  let signingKey = '';

  const commitLocally = (subject: string): void => {
    fs.writeFileSync(path.join(work, 'change.txt'), subject);
    git(work, 'add', '-A');
    git(work, 'commit', '-m', subject);
  };

  const commit = (subject: string): void => {
    commitLocally(subject);
    git(work, 'push', '--quiet', 'origin', 'main');
  };

  const releaseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...gitEnv(),
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_LOG: log,
    STUB_ORIGIN: origin,
    HOME: home,
    APPLE_API_KEY: keyFile,
    APPLE_API_KEY_ID: 'FAKEKEYID1',
    APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
    STUB_WORK: work,
    ...extra,
  });

  const release = (extra: NodeJS.ProcessEnv = {}, args: readonly string[] = []) =>
    spawnSync('/bin/bash', [path.join(work, 'scripts/release.sh'), ...args], { cwd: work, encoding: 'utf8', env: releaseEnv(extra) });

  const siteDeploy = (extra: NodeJS.ProcessEnv = {}) =>
    spawnSync('/bin/bash', [path.join(work, 'scripts/site-deploy.sh')], { cwd: work, encoding: 'utf8', env: releaseEnv(extra) });

  const loggedCalls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0) : []);
  const releaseNotes = (): string => fs.readFileSync(path.join(path.dirname(log), 'gh-release-notes.txt'), 'utf8');
  const loggedNames = (): string[] => loggedCalls().map((line) => line.split(' ')[0] as string);
  const originTags = (): string => git(origin, 'tag', '--list');
  const fetchesOf = (url: string): number => loggedCalls().filter((line) => line.startsWith('curl ') && line.includes(` ${url} `)).length;
  const outputOf = (siteLine: string): string => {
    const args = siteLine.split(' ');
    const at = args.indexOf('--output');
    return path.resolve(work, args[at + 1] as string);
  };
  const originRef = (ref: string): string => git(origin, 'rev-parse', '--verify', '--quiet', ref).trim();
  const originHasRef = (ref: string): boolean => spawnSync('/usr/bin/git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8', env: gitEnv() }).status === 0;
  const releasedCommit = (): string => originRef('refs/tags/v1.2.3^{commit}');
  const forgetFetches = (): void => {
    fs.rmSync(log, { force: true });
    for (const url of SITE_URLS) fs.rmSync(path.join(path.dirname(log), `curl-fetches-${url.split('/').at(-1) as string}`), { force: true });
  };

  beforeAll(() => {
    root = createTempRoot();
    stubs = path.join(root, 'stubs');
    fs.mkdirSync(stubs);
    for (const [name, body] of Object.entries(STUB_SOURCES)) {
      fs.writeFileSync(
        path.join(stubs, name),
        `#!/bin/sh\nprintf '%s %s\\n' "$(basename "$0")" "$(printf '%s ' "$@" | tr '\\n' '~')" >> "$STUB_LOG"\n${body}\n`,
        { mode: 0o755 },
      );
    }
    fs.writeFileSync(path.join(stubs, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    keyFile = path.join(root, 'AuthKey_FAKEKEYID1.p8');
    fs.writeFileSync(keyFile, 'fake key material');
    home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    signingKey = path.join(home, '.ssh/momonga-release');
    fs.writeFileSync(signingKey, 'fake ssh key');
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  beforeEach(() => {
    const instance = createTempDir({ parent: root });
    work = path.join(instance, 'work');
    origin = path.join(instance, 'origin.git');
    log = path.join(instance, 'stub.log');
    git(instance, 'init', '--bare', '--initial-branch=main', origin);
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(work, 'packages/cli'), { recursive: true });
    fs.copyFileSync(`${repoRoot}scripts/release.sh`, path.join(work, 'scripts/release.sh'));
    fs.copyFileSync(`${repoRoot}scripts/release-tools.sh`, path.join(work, 'scripts/release-tools.sh'));
    fs.copyFileSync(`${repoRoot}scripts/sea-entitlements.plist`, path.join(work, 'scripts/sea-entitlements.plist'));
    fs.copyFileSync(`${repoRoot}scripts/release-key.ts`, path.join(work, 'scripts/release-key.ts'));
    fs.symlinkSync(`${repoRoot}scripts/site-deploy.sh`, path.join(work, 'scripts/site-deploy.sh'));
    fs.symlinkSync(`${repoRoot}scripts/site-target.ts`, path.join(work, 'scripts/site-target.ts'));
    fs.mkdirSync(path.join(work, 'scripts/site'));
    fs.symlinkSync(`${repoRoot}scripts/site/bounded.ts`, path.join(work, 'scripts/site/bounded.ts'));
    fs.writeFileSync(path.join(work, 'scripts/site.ts'), FAKE_SITE_BUILD);
    for (const script of ['embedded-ripgrep.ts', 'ripgrep-release.ts', 'node-runtime.ts', 'z3-assets.ts', 'bundle.ts']) fs.symlinkSync(`${repoRoot}scripts/${script}`, path.join(work, 'scripts', script));
    fs.copyFileSync(`${repoRoot}THIRD-PARTY-NOTICES.md`, path.join(work, 'THIRD-PARTY-NOTICES.md'));
    for (const [file, content] of Object.entries(installers(PINNED_KEY))) fs.writeFileSync(path.join(work, file), content);
    fs.symlinkSync(`${repoRoot}node_modules`, path.join(work, 'node_modules'));
    fs.writeFileSync(path.join(work, 'packages/cli/package.json'), JSON.stringify({ name: 'momonga', version: '1.2.3' }));
    fs.writeFileSync(path.join(work, '.gitignore'), 'dist/\nnode_modules\n');
    git(work, 'init', '--initial-branch=main');
    git(work, 'remote', 'add', 'origin', origin);
    commit('first change');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(work), { recursive: true, force: true });
  });

  it('dry run executes no external command and lists every step in order', () => {
    commit('second change');
    const result = release({ DRY_RUN: '1' });
    expect(result.status).toBe(0);
    expect(loggedCalls()).toEqual([]);
    expect(originTags()).toBe('');
    expect(git(work, 'tag', '--list')).toBe('');
    const effects = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('DRY_RUN: '))
      .map((line) => line.split(' ').slice(1, 3).join(' '));
    expect(effects).toEqual([
      'npm run',
      'npm test',
      'mkdir -p',
      'npm run',
      `ripgrep-manifest ${work}/dist/release/momonga-darwin-arm64`,
      'codesign --sign',
      'codesign --verify',
      'codesign --display',
      `compare "${work}/dist/release/momonga-darwin-arm64`,
      'rm -f',
      'ditto -c',
      'xcrun notarytool',
      'xcrun notarytool',
      `env MOMONGA_SEA_SMOKE_EXECUTABLE=${work}/dist/release/momonga-darwin-arm64`,
      'npm run',
      'npm run',
      'npm run',
      `check ${work}/dist/release/momonga-linux-x64`,
      `check ${work}/dist/release/momonga-linux-arm64`,
      `check ${work}/dist/release/momonga-win-x64.exe`,
      `ripgrep-manifest ${work}/dist/release/momonga-linux-x64`,
      `ripgrep-manifest ${work}/dist/release/momonga-linux-arm64`,
      `ripgrep-manifest ${work}/dist/release/momonga-win-x64.exe`,
      'docker run',
      'docker run',
      'npm run',
      `node ${work}/scripts/site.ts`,
      'write_checksums',
      'rm -f',
      'ssh-keygen -Y',
      `node ${work}/scripts/release-key.ts`,
      `node ${work}/scripts/site/bounded.ts`,
      'gh release',
      'gh release',
      'git fetch',
      expect.stringContaining('scripts/site-deploy.sh'),
    ]);
    expect(result.stdout).toContain('Initial release v1.2.3.');
    expect(result.stdout).toContain(`DRY_RUN: node ${work}/scripts/site/bounded.ts 120 git push --quiet origin refs/heads/main:refs/heads/main\n`);
  });

  it('dry run with a local commit not yet on origin pushes nothing', () => {
    const published = originRef('refs/heads/main');
    commitLocally('unpushed change');
    const result = release({ DRY_RUN: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(loggedCalls()).toEqual([]);
    expect(originRef('refs/heads/main')).toBe(published);
    expect(result.stdout).toContain('git push --quiet origin refs/heads/main:refs/heads/main');
  });

  it('live run with stubs performs the steps in the documented order', () => {
    commit('second change');
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    const binary = `${work}/dist/release/momonga-darwin-arm64`;
    const calls = loggedCalls();
    const published = calls.slice(0, 22);
    expect(published.map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
      'docker info',
      'npm run',
      'npm test',
      'npm run',
      'codesign --sign',
      'codesign --verify',
      'codesign --display',
      'ditto -c',
      'xcrun notarytool',
      'xcrun notarytool',
      'npx vitest',
      'npm run',
      'npm run',
      'npm run',
      'docker run',
      'docker run',
      'npm run',
      'site --output',
      'ssh-keygen -Y',
      'ssh-keygen -Y',
      'gh release',
      'gh release',
    ]);
    expect(calls.slice(0, 3)).toEqual(['docker info ', 'npm run typecheck ', 'npm test ']);
    const updateSourceFlags = `--repo fake-owner/fake-repo --team-id ${TEAM_ID} --release-public-key ${PINNED_KEY} `;
    expect(calls[3]).toBe(`npm run sea -- --unsigned --output ${binary} ${updateSourceFlags}`);
    expect(calls[4]).toBe(
      `codesign --sign ${SIGNING_IDENTITY} --force --timestamp --options runtime --entitlements ${work}/scripts/sea-entitlements.plist ${binary} `,
    );
    expect(calls[5]).toBe(`codesign --verify --strict --verbose=2 ${binary} `);
    expect(calls[6]).toBe(`codesign --display --verbose=4 ${binary} `);
    expect(calls[8]).toBe(
      `xcrun notarytool submit ${binary}.zip --key ${keyFile} --key-id FAKEKEYID1 --issuer 00000000-0000-0000-0000-000000000000 --wait --output-format json `,
    );
    expect(calls[9]).toBe(
      `xcrun notarytool log fake-submission --key ${keyFile} --key-id FAKEKEYID1 --issuer 00000000-0000-0000-0000-000000000000 `,
    );
    expect(calls[10]).toBe('npx vitest run --project packaging scripts/sea-smoke.test.ts ');
    const out = `${work}/dist/release`;
    expect(calls.slice(11, 14)).toEqual(
      ['linux-x64', 'linux-arm64', 'win-x64'].map(
        (target) => `npm run sea -- --unsigned --target ${target} --output ${out}/momonga-${target}${target === 'win-x64' ? '.exe' : ''} ${updateSourceFlags}`,
      ),
    );
    expect(calls.slice(14, 16).map((line) => line.split(' ').slice(0, 4).join(' '))).toEqual(['docker run --rm -i', 'docker run --rm -i']);
    expect(calls[14]).toContain('--platform linux/amd64 ');
    expect(calls[14]).toContain('MOMONGA_SEA_SMOKE_EXECUTABLE=dist/release/momonga-linux-x64 node_modules/.bin/vitest run --project packaging scripts/sea-smoke.test.ts');
    expect(calls[15]).toContain('--platform linux/arm64 ');
    expect(calls[15]).toContain('MOMONGA_SEA_SMOKE_EXECUTABLE=dist/release/momonga-linux-arm64 node_modules/.bin/vitest run --project packaging scripts/sea-smoke.test.ts');
    expect(calls[16]).toBe(`npm run notices -- --output ${out}/THIRD-PARTY-NOTICES.md `);
    expect(calls[17]).toMatch(/^site --output \S+ $/);
    expect(calls[18]).toBe(`ssh-keygen -Y sign -f ${signingKey} -n momonga-release ${out}/SHA256SUMS `);
    expect(calls[19]).toMatch(/^ssh-keygen -Y verify -f \S+ -I momonga-release -n momonga-release -s \S+ $/);
    expect(calls[20]).toContain(
      `gh release create v1.2.3 ${binary} ${out}/momonga-linux-x64 ${out}/momonga-linux-arm64 ${out}/momonga-win-x64.exe ${out}/THIRD-PARTY-NOTICES.md ${out}/SHA256SUMS ${out}/SHA256SUMS.sig --repo fake-owner/fake-repo --draft --target ${git(work, 'rev-parse', 'HEAD').trim()} --title v1.2.3 --notes-file `,
    );
    expect(releaseNotes()).toBe('Initial release v1.2.3.\n');
    expect(calls[21]).toBe('gh release edit v1.2.3 --repo fake-owner/fake-repo --draft=false ');
    const deployed = calls.slice(22);
    expect(deployed[0]).toMatch(/^site --output \S+ $/);
    expect(fs.existsSync(path.join(outputOf(deployed[0] as string), 'install.sh'))).toBe(true);
    expect(deployed.slice(1).length).toBeGreaterThanOrEqual(2);
    expect(deployed.slice(1).every((line) => line.startsWith('curl '))).toBe(true);
    expect(originRef('refs/heads/site')).toBe(releasedCommit());
    expect(originRef('refs/heads/main')).toBe(git(work, 'rev-parse', 'HEAD').trim());
    for (const url of SITE_URLS) expect(fetchesOf(url)).toBeGreaterThanOrEqual(1);
    expect(result.stderr).not.toContain(SITE_DEPLOY_FAILED);
    expect(originTags()).toBe('v1.2.3\n');
    expect(git(work, 'tag', '--list')).toBe('v1.2.3\n');
    const sums = fs.readFileSync(`${work}/dist/release/SHA256SUMS`, 'utf8').trimEnd().split('\n');
    expect(sums.map((line) => line.replace(/^[0-9a-f]{64} {2}/, ''))).toEqual(['momonga-darwin-arm64', 'momonga-linux-x64', 'momonga-linux-arm64', 'momonga-win-x64.exe', 'THIRD-PARTY-NOTICES.md']);
  });

  it('refuses to build or publish when the installers pin no release key, and says what to do', () => {
    for (const [file, content] of Object.entries(installers(''))) fs.writeFileSync(path.join(work, file), content);
    git(work, 'add', '-A');
    commit('unpin the release key');

    const result = release();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no release signing key is pinned in scripts/install.sh and scripts/install.ps1');
    expect(result.stderr).toContain('ssh-keygen -y -f <RELEASE_SIGNING_KEY>');
    expect(loggedCalls()).toEqual([]);
    expect(originTags()).toBe('');
  });

  it('refuses to build when the two installers pin different keys', () => {
    fs.writeFileSync(path.join(work, 'scripts/install.ps1'), installers(`${PINNED_KEY.slice(0, -4)}AAAA`)['scripts/install.ps1'] as string);
    commit('diverge the pins');

    const result = release();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pin different release public keys');
    expect(loggedCalls()).toEqual([]);
  });

  it('does not publish when the key pinned in the installers does not verify the signature it just made', () => {
    commit('second change');

    const result = release({ STUB_SSH_VERIFY_EXIT: String(SIGNATURE_REJECTED_EXIT_CODE), STUB_SSH_REJECT_KEY: PINNED_KEY });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not signed by the release key pinned in the installers; refusing to publish');
    expect(loggedNames().slice(-2)).toEqual(['ssh-keygen', 'ssh-keygen']);
    expect(loggedNames()).not.toContain('gh');
    expect(originTags()).toBe('');
  });

  it('uses a concise initial release note when there is no previous tag', () => {
    commit('second change');
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    expect(releaseNotes()).toBe('Initial release v1.2.3.\n');
  });

  it('covers only the commits since the previous tag', () => {
    git(work, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    commit('second change');
    commit('third change');
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    const notes = releaseNotes();
    expect(notes).toContain('- third change (');
    expect(notes).toContain('- second change (');
    expect(notes).not.toContain('first change');
  });

  it('truncates commit notes cleanly when they exceed the release note character limit', () => {
    git(work, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    commit('change one with a moderately long commit subject');
    commit('change two with a moderately long commit subject');
    commit('change three with a moderately long commit subject');
    const result = release({ MOMONGA_RELEASE_MAX_NOTES_CHARS: '90' });
    expect(result.status, result.stderr).toBe(0);
    const notes = releaseNotes().trimEnd();
    expect(notes.length).toBeLessThanOrEqual(90);
    expect(notes).toContain('- change three with a moderately long commit subject (');
    expect(notes).toContain('- ...and 2 more commits');
  });

  it('--notes-file uses the provided release notes file and rejects missing or empty files', () => {
    commit('second change');
    const missing = release({}, ['--notes-file', path.join(root, 'no-such-notes.md')]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('does not exist');
    expect(loggedCalls()).toEqual([]);

    const emptyFile = path.join(root, 'empty-notes.md');
    fs.writeFileSync(emptyFile, '   \n');
    const empty = release({}, ['--notes-file', emptyFile]);
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain('is empty');

    const customFile = path.join(root, 'custom-notes.md');
    fs.writeFileSync(customFile, '## Highlights\n- Custom release notes\n');
    const ok = release({}, ['--notes-file', customFile]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(releaseNotes()).toBe('## Highlights\n- Custom release notes\n');
  });

  it.each([
    ['the darwin-arm64 executable', { STUB_RIPGREP_TARGET: 'linux-x64' }, 'momonga-darwin-arm64 embeds the ripgrep manifest of linux-x64, not of darwin-arm64'],
    ['a cross-built executable', { STUB_RIPGREP_VERSION: '14.1.0' }, 'embeds ripgrep 14.1.0, not the pinned 15.2.0'],
  ] as const)('stops before publishing when %s does not embed the ripgrep manifest of its own target', (_label, env, message) => {
    commit('second change');
    const result = release(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(loggedNames()).not.toContain('gh');
    expect(originTags()).toBe('');
  });

  it('stops before publishing when the signed macOS executable does not start on this host', () => {
    commit('second change');
    const result = release({ STUB_SMOKE_EXIT: '1' });
    expect(result.status).not.toBe(0);
    expect(loggedNames()).not.toContain('gh');
    expect(originTags()).toBe('');
  });

  it('stops before publishing when a linux executable does not start in its container', () => {
    commit('second change');
    const result = release({ STUB_CONTAINER_SMOKE_EXIT: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the smoke run of momonga-linux-x64 in a linux/amd64 container did not end with EXIT=0');
    expect(loggedNames()).not.toContain('gh');
  });

  it('stops before running tests or building when the docker daemon is not running', () => {
    commit('second change');
    const result = release({ STUB_DOCKER_INFO_EXIT: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: docker daemon is not running; start Docker or pass --skip-linux-smoke / --skip-smoke; nothing was built\n');
    expect(loggedCalls()).toEqual(['docker info ']);
    expect(originTags()).toBe('');
  });

  it('stops before publishing when the notarization log command fails', () => {
    commit('second change');
    const result = release({ STUB_NOTARY_LOG_EXIT: '1' });
    expect(result.status).not.toBe(0);
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign', 'ditto', 'xcrun', 'xcrun']);
    expect(originTags()).toBe('');
    expect(fs.existsSync(`${work}/dist/release/SHA256SUMS`)).toBe(false);
  });

  it('stops before publishing when the notarization ticket does not include the binary CDHash', () => {
    commit('second change');
    const result = release({ STUB_NOTARY_CDHASH: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('notarization ticket does not include CDHash aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign', 'ditto', 'xcrun', 'xcrun']);
    expect(originTags()).toBe('');
    expect(fs.existsSync(`${work}/dist/release/SHA256SUMS`)).toBe(false);
  });

  it('stops before publishing when the notarization log status is not Accepted', () => {
    commit('second change');
    const result = release({ STUB_NOTARY_LOG_STATUS: 'Invalid' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: notarization log status is not Accepted\n');
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign', 'ditto', 'xcrun', 'xcrun']);
    expect(originTags()).toBe('');
  });

  it('stops when notarization is not accepted', () => {
    commit('second change');
    const result = release({ STUB_NOTARY_STATUS: 'Invalid' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: notarization was not accepted\n');
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign', 'ditto', 'xcrun']);
    expect(originTags()).toBe('');
  });

  it('accepts a signed binary whose codesign display is far larger than a pipe', () => {
    commit('second change');
    const result = release({ STUB_DISPLAY_PADDING_LINES: '40000' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts a notarization whose output is far larger than a pipe', () => {
    commit('second change');
    const result = release({ STUB_NOTARY_PADDING_LINES: '10000' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('finds the previous tag among tags whose listing is far larger than a pipe', () => {
    commit('second change');
    const refs = Array.from({ length: 3000 }, (_, index) => `create refs/tags/v0.0.${index}-${'x'.repeat(200)} HEAD~1`).join('\n');
    const update = spawnSync('/usr/bin/git', ['update-ref', '--stdin'], { cwd: work, encoding: 'utf8', env: gitEnv(), input: `${refs}\n` });
    expect(update.status, update.stderr).toBe(0);
    const result = release({ DRY_RUN: '1' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('stops before notarization when the signed binary carries another Team ID', () => {
    commit('second change');
    const result = release({ STUB_TEAM_ID: 'OTHER00000' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(`release.sh: the signed binary does not carry TeamIdentifier=${TEAM_ID}\n`);
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign']);
    expect(originTags()).toBe('');
  });

  it('uses the signing identity, Team ID and signing key path written in release.sh and ignores the old environment variables', () => {
    commit('second change');
    const decoyKey = path.join(root, 'decoy_signing_key');
    fs.writeFileSync(decoyKey, 'decoy ssh key');
    const result = release({
      SIGNING_IDENTITY: 'Developer ID Application: Fake Person (FAKE000000)',
      MOMONGA_TEAM_ID: 'FAKE000000',
      RELEASE_SIGNING_KEY: decoyKey,
      MOMONGA_REPO: 'env-owner/env-repo',
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = loggedCalls();
    const binary = `${work}/dist/release/momonga-darwin-arm64`;
    expect(calls[3]).toBe(`npm run sea -- --unsigned --output ${binary} --repo fake-owner/fake-repo --team-id ${TEAM_ID} --release-public-key ${PINNED_KEY} `);
    expect(calls[4]).toContain(`codesign --sign ${SIGNING_IDENTITY} --force`);
    expect(calls[18]).toBe(`ssh-keygen -Y sign -f ${signingKey} -n momonga-release ${work}/dist/release/SHA256SUMS `);
    expect(calls.join('\n')).not.toContain('env-owner/env-repo');
    expect(calls.join('\n')).not.toContain('FAKE000000');
  });

  it('gets past the environment check with only APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER set', () => {
    commit('second change');
    const env = releaseEnv();
    for (const name of ['SIGNING_IDENTITY', 'MOMONGA_TEAM_ID', 'RELEASE_SIGNING_KEY', 'MOMONGA_REPO']) delete env[name];
    const result = spawnSync('/bin/bash', [path.join(work, 'scripts/release.sh')], { cwd: work, encoding: 'utf8', env });
    expect(result.stderr).not.toContain('is not set');
    expect(result.status, result.stderr).toBe(0);
    expect(loggedCalls().slice(0, 3)).toEqual(['docker info ', 'npm run typecheck ', 'npm test ']);
  });

  it('refuses to start when the release signing key is not at $HOME/.ssh/momonga-release', () => {
    const emptyHome = createTempDir({ parent: root });
    const result = release({ HOME: emptyHome });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${emptyHome}/.ssh/momonga-release`);
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses to build or publish when neither installer names the repository, and says what to do', () => {
    for (const [file, content] of Object.entries(installers(PINNED_KEY, ''))) fs.writeFileSync(path.join(work, file), content);
    commit('forget the repository');

    const result = release({ MOMONGA_REPO: 'env-owner/env-repo' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('<owner>/<repo>');
    expect(result.stderr).toContain('scripts/install.sh');
    expect(result.stderr).toContain('scripts/install.ps1');
    expect(result.stderr).toContain('commit');
    expect(loggedCalls()).toEqual([]);
    expect(originTags()).toBe('');
    expect(fs.existsSync(`${work}/dist/release`)).toBe(false);
  });

  it.each([
    ['different repositories', 'fake-owner/fake-repo', 'other-owner/other-repo'],
    ['a repository in only one installer', 'fake-owner/fake-repo', ''],
  ])('refuses to build when the installers name %s', (_label, shellRepo, powershellRepo) => {
    for (const [file, content] of Object.entries(installers(PINNED_KEY, shellRepo, powershellRepo))) fs.writeFileSync(path.join(work, file), content);
    commit('diverge the repositories');

    const result = release();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('scripts/install.sh');
    expect(result.stderr).toContain('scripts/install.ps1');
    expect(loggedCalls()).toEqual([]);
    expect(originTags()).toBe('');
  });

  it('refuses a malformed repository in the installers before any command', () => {
    for (const [file, content] of Object.entries(installers(PINNED_KEY, 'no-slash'))) fs.writeFileSync(path.join(work, file), content);
    commit('malformed repository');

    const result = release();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("release.sh: MOMONGA_REPO must be <owner>/<repo>, got 'no-slash'\n");
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses to start without a credential', () => {
    const result = release({ APPLE_API_ISSUER: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: APPLE_API_ISSUER is not set\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('builds the site after the notices and before the checksums, so a failed build publishes nothing', () => {
    commit('second change');
    const result = release({ STUB_SITE_FAIL: '1' });
    expect(result.status).not.toBe(0);
    const calls = loggedCalls();
    expect(calls.at(-1)).toMatch(/^site --output \S+ $/);
    expect(calls.at(-2)).toBe(`npm run notices -- --output ${work}/dist/release/THIRD-PARTY-NOTICES.md `);
    expect(loggedNames()).not.toContain('gh');
    expect(loggedNames()).not.toContain('ssh-keygen');
    expect(originHasRef('refs/heads/site')).toBe(false);
    expect(originTags()).toBe('');
    expect(fs.existsSync(`${work}/dist/release/SHA256SUMS`)).toBe(false);
  });

  it.each([
    ['ahead of', (released: string): void => {
      git(work, 'commit', '--allow-empty', '-m', 'ahead of the release');
      git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/site`);
      git(work, 'reset', '--quiet', '--hard', released);
    }],
    ['diverged from', (released: string): void => {
      git(work, 'checkout', '--quiet', '--detach', `${released}~1`);
      git(work, 'commit', '--allow-empty', '-m', 'diverged from the release');
      git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/site`);
      git(work, 'checkout', '--quiet', 'main');
    }],
  ] as const)('keeps the published release and its tag when the branch site of origin is %s the released commit, and names the command to run again', (_label, moveSite) => {
    commit('second change');
    const main = git(work, 'rev-parse', 'HEAD').trim();
    moveSite(main);
    const site = originRef('refs/heads/site');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(siteBranchNotMoved(releasedCommit()));
    expect(result.stderr).toContain(SITE_DEPLOY_FAILED);
    expect(originRef('refs/heads/site')).toBe(site);
    expect(originRef('refs/heads/main')).toBe(main);
    expect(originTags()).toBe('v1.2.3\n');
    expect(git(work, 'tag', '--list')).toBe('v1.2.3\n');
    expect(loggedCalls().some((line) => line.startsWith('gh release delete'))).toBe(false);
    expect(loggedNames()).not.toContain('curl');
  });

  it.each([
    ['other bytes', { STUB_CURL_BYTES: 'other' }],
    ['another content type', { STUB_CURL_TYPE: 'text/html; charset=utf-8' }],
    ['an untyped binary', { STUB_CURL_TYPE: 'application/octet-stream' }],
    ['no charset', { STUB_CURL_TYPE: 'text/plain' }],
  ] as const)('fails after its bounded tries when the served installers have %s, and keeps the release', (_label, env) => {
    commit('second change');
    const result = release(env);
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(SITE_DEPLOY_FAILED);
    expect(SITE_URLS.some((url) => fetchesOf(url) >= 2)).toBe(true);
    expect(originTags()).toBe('v1.2.3\n');
    expect(loggedCalls().some((line) => line.startsWith('gh release delete'))).toBe(false);
  });

  it.each(['text/plain;charset=UTF-8', 'Text/Plain; charset="utf-8"'])('accepts the served installers when their content type is spelled %s', (type) => {
    commit('second change');
    const result = release({ STUB_CURL_TYPE: type });
    expect(result.status, result.stderr).toBe(0);
    expect(originRef('refs/heads/site')).toBe(releasedCommit());
  });

  it('deploys a release cut from the branch named by MOMONGA_RELEASE_BRANCH', () => {
    git(work, 'checkout', '--quiet', '-b', 'stable');
    commitLocally('second change');
    git(work, 'push', '--quiet', 'origin', 'stable');
    const result = release({ MOMONGA_RELEASE_BRANCH: 'stable' });
    expect(result.status, result.stderr).toBe(0);
    expect(originRef('refs/heads/site')).toBe(git(work, 'rev-parse', 'HEAD').trim());
  });

  it('site-deploy.sh refuses a shallow clone before checking HEAD against origin main', () => {
    commit('second change');
    commit('third change');
    const shallow = path.join(path.dirname(work), 'shallow');
    git(path.dirname(work), 'clone', '--quiet', '--depth', '1', `file://${origin}`, shallow);
    const result = spawnSync('/bin/bash', [path.join(shallow, 'scripts/site-deploy.sh')], { cwd: shallow, encoding: 'utf8', env: releaseEnv() });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('site-deploy.sh: this clone is shallow; deploying the site needs a full clone of the repository (git fetch --unshallow); nothing was deployed\n');
    expect(originHasRef('refs/heads/site')).toBe(false);
    expect(loggedCalls()).toEqual([]);
  });

  it('tries the served installers again until the new deployment serves them', () => {
    commit('second change');
    const result = release({ STUB_CURL_STALE_FETCHES: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(SITE_URLS.some((url) => fetchesOf(url) >= 2)).toBe(true);
  });

  it('moves the branch site of origin to an untagged commit of origin main when site-deploy.sh is run alone, and pushes nothing new when run again', () => {
    commit('second change');
    const head = git(work, 'rev-parse', 'HEAD').trim();
    const result = siteDeploy();
    expect(result.status, result.stderr).toBe(0);
    const calls = loggedCalls();
    expect(calls[0]).toMatch(/^site --output \S+ $/);
    expect(calls.slice(1).length).toBeGreaterThanOrEqual(2);
    expect(calls.slice(1).every((line) => line.startsWith('curl '))).toBe(true);
    for (const url of SITE_URLS) expect(fetchesOf(url)).toBeGreaterThanOrEqual(1);
    expect(loggedNames()).not.toContain('gh');
    expect(originTags()).toBe('');
    expect(originRef('refs/heads/site')).toBe(head);
    expect(originRef('refs/heads/main')).toBe(head);
    forgetFetches();
    const again = siteDeploy();
    expect(again.status, again.stderr).toBe(0);
    expect(originRef('refs/heads/site')).toBe(head);
    for (const url of SITE_URLS) expect(fetchesOf(url)).toBeGreaterThanOrEqual(1);
  });

  it('site-deploy.sh run alone on an ancestor of origin main moves the branch site to it', () => {
    commit('second change');
    const earlier = git(work, 'rev-parse', 'HEAD').trim();
    commit('third change');
    git(work, 'checkout', '--quiet', '--detach', earlier);
    const published = originRef('refs/heads/main');
    const result = siteDeploy();
    expect(result.status, result.stderr).toBe(0);
    expect(originRef('refs/heads/site')).toBe(earlier);
    expect(originRef('refs/heads/main')).toBe(published);
  });

  it('site-deploy.sh run alone refuses to move a branch site of origin that is ahead of HEAD', () => {
    commit('second change');
    const head = git(work, 'rev-parse', 'HEAD').trim();
    git(work, 'commit', '--allow-empty', '-m', 'ahead of main');
    git(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/site');
    const site = originRef('refs/heads/site');
    git(work, 'reset', '--quiet', '--hard', head);
    const result = siteDeploy();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(siteBranchNotMoved(head));
    expect(originRef('refs/heads/site')).toBe(site);
    expect(loggedNames()).not.toContain('curl');
  });

  it('site-deploy.sh pushes main first when HEAD is a local commit of main that origin does not have', () => {
    commit('second change');
    commitLocally('third change');
    const head = git(work, 'rev-parse', 'HEAD').trim();
    const result = siteDeploy();
    expect(result.status, result.stderr).toBe(0);
    expect(originRef('refs/heads/main')).toBe(head);
    expect(originRef('refs/heads/site')).toBe(head);
  });

  it('site-deploy.sh refuses when main of origin has diverged from HEAD', () => {
    commit('on origin only');
    git(work, 'reset', '--quiet', '--hard', 'HEAD~1');
    commitLocally('local only');
    const published = originRef('refs/heads/main');
    const result = siteDeploy();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(ORIGIN_AHEAD_OF_DEPLOY);
    expect(originRef('refs/heads/main')).toBe(published);
    expect(originHasRef('refs/heads/site')).toBe(false);
    expect(loggedCalls()).toEqual([]);
  });

  it('site-deploy.sh refuses a detached HEAD that main of origin does not contain', () => {
    commit('second change');
    git(work, 'checkout', '--quiet', '--detach');
    commitLocally('detached change');
    const result = siteDeploy();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(NOT_ON_ORIGIN_MAIN);
    expect(originHasRef('refs/heads/site')).toBe(false);
    expect(loggedCalls()).toEqual([]);
  });

  it('site-deploy.sh refuses a dirty working tree', () => {
    commit('second change');
    expect(release().status).toBe(0);
    fs.rmSync(log, { force: true });
    fs.writeFileSync(path.join(work, 'untracked.txt'), 'x');
    const result = siteDeploy();
    expect(result.status).not.toBe(0);
    expect(originRef('refs/heads/site')).toBe(releasedCommit());
    expect(loggedNames()).not.toContain('curl');
    fs.rmSync(path.join(work, 'untracked.txt'));
    fs.rmSync(log, { force: true });
    const clean = siteDeploy();
    expect(clean.status, clean.stderr).toBe(0);
    expect(originRef('refs/heads/site')).toBe(releasedCommit());
  });

  it('site-deploy.sh refuses when cmp is not on PATH', () => {
    commit('second change');
    const bare = createTempDir({ parent: root });
    for (const name of fs.readdirSync(stubs)) fs.symlinkSync(path.join(stubs, name), path.join(bare, name));
    fs.symlinkSync(process.execPath, path.join(bare, 'node'));
    for (const name of ['git', 'dirname']) fs.symlinkSync(`/usr/bin/${name}`, path.join(bare, name));
    const result = siteDeploy({ PATH: bare });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('site-deploy.sh: deploying the site needs cmp on PATH, not found; nothing was deployed\n');
    expect(originHasRef('refs/heads/site')).toBe(false);
    expect(loggedCalls()).toEqual([]);
    const found = siteDeploy();
    expect(found.status, found.stderr).toBe(0);
    expect(originRef('refs/heads/site')).toBe(git(work, 'rev-parse', 'HEAD').trim());
  });

  it('refuses to start from a dirty working tree', () => {
    fs.writeFileSync(path.join(work, 'untracked.txt'), 'x');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: working tree is not clean\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses a tag that already exists', () => {
    git(work, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: tag v1.2.3 already exists\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('runs typecheck and every test project before building anything', () => {
    commit('second change');
    expect(release().status).toBe(0);
    expect(loggedCalls().slice(0, 3)).toEqual(['docker info ', 'npm run typecheck ', 'npm test ']);
  });

  it('--skip-test-suite skips only npm test while still running typecheck and smoke tests', () => {
    commit('second change');
    const result = release({}, ['--skip-test-suite']);
    expect(result.status, result.stderr).toBe(0);
    const calls = loggedCalls();
    expect(calls.slice(0, 2)).toEqual(['docker info ', 'npm run typecheck ']);
    expect(calls[2]).toContain('npm run sea -- ');
    expect(calls.some((line) => line === 'npm test ')).toBe(false);
    expect(calls).toContain('npx vitest run --project packaging scripts/sea-smoke.test.ts ');
    expect(calls.filter((line) => line.startsWith('docker run ')).length).toBe(2);
    expect(originTags()).toBe('v1.2.3\n');
  });

  it('--skip-linux-smoke skips docker check and linux container smoke while still running npm test and macOS smoke', () => {
    commit('second change');
    const result = release({ STUB_DOCKER_INFO_EXIT: '1' }, ['--skip-linux-smoke']);
    expect(result.status, result.stderr).toBe(0);
    const calls = loggedCalls();
    expect(calls.some((line) => line.startsWith('docker '))).toBe(false);
    expect(calls).toContain('npm test ');
    expect(calls).toContain('npx vitest run --project packaging scripts/sea-smoke.test.ts ');
    expect(originTags()).toBe('v1.2.3\n');
  });

  it('--skip-smoke skips both macOS and linux smoke tests while still running npm test', () => {
    commit('second change');
    const result = release({ STUB_DOCKER_INFO_EXIT: '1', STUB_SMOKE_EXIT: '1' }, ['--skip-smoke']);
    expect(result.status, result.stderr).toBe(0);
    const calls = loggedCalls();
    expect(calls).toContain('npm test ');
    expect(calls.some((line) => line.startsWith('docker '))).toBe(false);
    expect(calls.some((line) => line.startsWith('npx vitest '))).toBe(false);
    expect(originTags()).toBe('v1.2.3\n');
  });

  it('--skip-test-suite and --skip-linux-smoke combine to run macOS smoke without npm test or docker', () => {
    commit('second change');
    const result = release({ STUB_DOCKER_INFO_EXIT: '1' }, ['--skip-test-suite', '--skip-linux-smoke']);
    expect(result.status, result.stderr).toBe(0);
    const calls = loggedCalls();
    expect(calls.some((line) => line === 'npm test ')).toBe(false);
    expect(calls.some((line) => line.startsWith('docker '))).toBe(false);
    expect(calls).toContain('npx vitest run --project packaging scripts/sea-smoke.test.ts ');
    expect(originTags()).toBe('v1.2.3\n');
  });

  it('--skip-test-suite and --skip-smoke combine to skip all test suites and smoke runs while still verifying and publishing', () => {
    commit('second change');
    const result = release({ STUB_DOCKER_INFO_EXIT: '1', STUB_SMOKE_EXIT: '1' }, ['--skip-test-suite', '--skip-smoke']);
    expect(result.status, result.stderr).toBe(0);
    const calls = loggedCalls();
    expect(calls[0]).toBe('npm run typecheck ');
    expect(calls.some((line) => line === 'npm test ')).toBe(false);
    expect(calls.some((line) => line.startsWith('docker '))).toBe(false);
    expect(calls.some((line) => line.startsWith('npx vitest '))).toBe(false);
    expect(originTags()).toBe('v1.2.3\n');
  });

  it('rejects an unknown option before running any command', () => {
    const result = release({}, ['--bogus']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("release.sh: unknown option '--bogus' (supported: --skip-test-suite, --skip-linux-smoke, --skip-smoke, --notes-file <path>)\n");
    expect(loggedCalls()).toEqual([]);
  });

  it.each(['typecheck', 'test'])('stops before building when %s fails', (script) => {
    commit('second change');
    const result = release({ STUB_NPM_FAIL: script });
    expect(result.status).not.toBe(0);
    expect(loggedNames().every((name) => name === 'docker' || name === 'npm')).toBe(true);
    expect(loggedCalls().some((line) => line.includes('sea'))).toBe(false);
    expect(originTags()).toBe('');
  });

  it('refuses to release from another branch', () => {
    git(work, 'checkout', '-q', '-b', 'feature');
    commitLocally('second change');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: releases are cut from main, not feature\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('pushes local commits that origin does not have yet and releases them', () => {
    commitLocally('unpushed change');
    commitLocally('another unpushed change');
    const head = git(work, 'rev-parse', 'HEAD').trim();
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    expect(originRef('refs/heads/main')).toBe(head);
    expect(releasedCommit()).toBe(head);
    expect(originRef('refs/heads/site')).toBe(head);
  });

  it('pushes nothing when the site build fails', () => {
    const published = originRef('refs/heads/main');
    commitLocally('unpushed change');
    const result = release({ STUB_SITE_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(originRef('refs/heads/main')).toBe(published);
    expect(loggedNames()).not.toContain('gh');
  });

  it('stops before any gh call when the push of main fails', () => {
    const published = originRef('refs/heads/main');
    commitLocally('unpushed change');
    git(work, 'config', 'remote.origin.pushurl', path.join(path.dirname(work), 'unreachable.git'));
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr.endsWith(RELEASE_PUSH_FAILED)).toBe(true);
    expect(loggedNames()).toContain('ssh-keygen');
    expect(loggedNames()).not.toContain('gh');
    expect(originRef('refs/heads/main')).toBe(published);
    expect(originTags()).toBe('');
  });

  it.each([
    ['ahead of', (): void => {
      commit('on origin only');
      git(work, 'reset', '--quiet', '--hard', 'HEAD~1');
    }],
    ['diverged from', (): void => {
      commit('on origin only');
      git(work, 'reset', '--quiet', '--hard', 'HEAD~1');
      commitLocally('local only');
    }],
  ] as const)('refuses at the start when main of origin is %s HEAD', (_label, arrange) => {
    arrange();
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(ORIGIN_AHEAD_OF_RELEASE);
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses a tag that origin already has even when the local clone does not', () => {
    git(work, 'tag', 'v1.2.3');
    git(work, 'push', '--quiet', 'origin', 'refs/tags/v1.2.3');
    git(work, 'tag', '--delete', 'v1.2.3');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: tag v1.2.3 already exists on origin\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('stops before notarization when the built binary reports another version than the tag', () => {
    commit('second change');
    const result = release({ STUB_BINARY_VERSION: '9.9.9' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("release.sh: the built binary reports version '9.9.9', not 1.2.3\n");
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign']);
    expect(originTags()).toBe('');
  });

  it('stops before publishing when a built Linux executable is not an ELF file', () => {
    commit('second change');
    const result = release({ STUB_LINUX_NOT_ELF: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not an ELF executable');
    expect(loggedNames()).not.toContain('gh');
    expect(originTags()).toBe('');
  });

  it('publishes no tag when creating the draft release fails, and removes the draft it may have created', () => {
    commit('second change');
    const result = release({ STUB_GH_FAIL_ON: 'create' });
    expect(result.status).not.toBe(0);
    expect(originTags()).toBe('');
    expect(git(work, 'tag', '--list')).toBe('');
    expect(loggedCalls().at(-1)).toBe('gh release delete v1.2.3 --yes --repo fake-owner/fake-repo ');
  });

  it('deletes the draft and tags nothing when publishing it fails, so that a rerun starts clean', () => {
    commit('second change');
    const result = release({ STUB_GH_FAIL_ON: 'edit' });
    expect(result.status).not.toBe(0);
    expect(originTags()).toBe('');
    expect(loggedCalls().at(-1)).toBe('gh release delete v1.2.3 --yes --repo fake-owner/fake-repo ');
    fs.rmSync(log, { force: true });
    expect(release().status).toBe(0);
    expect(originTags()).toBe('v1.2.3\n');
  });

  it('rejects an invalid DRY_RUN value', () => {
    const result = release({ DRY_RUN: 'yes' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("release.sh: DRY_RUN must be 0 or 1, got 'yes'\n");
  });
});
