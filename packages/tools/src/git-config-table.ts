export type ConfigEntry = readonly [key: string, value: string];

export type OverrideGroup = 'program' | 'protocol' | 'transport' | 'recursion' | 'credential';

export type RepositoryKeyRule =
  | { readonly key: string; readonly why: string; readonly verdict: 'inert' }
  | { readonly key: string; readonly why: string; readonly verdict: 'overridden'; readonly set: ConfigEntry; readonly group: OverrideGroup }
  | { readonly key: string; readonly why: string; readonly verdict: 'refused'; readonly rewrite?: ConfigEntry };

export type UrlRewrite = { readonly from: string; readonly to: string };

export const DESTINATION_PLACE = '{destination}';

const REWRITTEN_TO = '{to}';
const REWRITTEN_FROM = '{from}';

export const GIT_PROTOCOLS: readonly string[] = ['ext', 'file', 'ftp', 'ftps', 'git', 'http', 'https', 'ssh'];

const NO_PROGRAM = '/dev/null';
const NO_EDITOR = ':';
const ALTERNATE_REFS_DEFAULT = "f() { git --git-dir=\"$1\" for-each-ref --format='%(objectname)'; }; f";

const inert = (why: string, keys: readonly string[]): RepositoryKeyRule[] => keys.map((key) => ({ key, why, verdict: 'inert' }));

const refused = (why: string, keys: readonly string[]): RepositoryKeyRule[] => keys.map((key) => ({ key, why, verdict: 'refused' }));

const overridden = (group: OverrideGroup, why: string, entries: readonly ConfigEntry[]): RepositoryKeyRule[] =>
  entries.map((set) => ({ key: set[0].toLowerCase(), why, verdict: 'overridden', set, group }));

const scopedLike = (group: OverrideGroup, why: string, section: string, entries: readonly ConfigEntry[]): RepositoryKeyRule[] =>
  entries.flatMap(([variable, value]): RepositoryKeyRule[] => [
    { key: `${section}.${variable.toLowerCase()}`, why, verdict: 'overridden', set: [`${section}.${variable}`, value], group },
    { key: `${section}.*.${variable.toLowerCase()}`, why, verdict: 'overridden', set: [`${section}.${variable}`, value], group },
  ]);

const perDestination = (why: string, entries: readonly ConfigEntry[]): RepositoryKeyRule[] =>
  entries.flatMap(([variable, value]): RepositoryKeyRule[] => [
    { key: `http.${variable.toLowerCase()}`, why, verdict: 'overridden', set: [`http.${variable}`, value], group: 'transport' },
    { key: `http.*.${variable.toLowerCase()}`, why, verdict: 'overridden', set: [`http.${DESTINATION_PLACE}.${variable}`, value], group: 'transport' },
  ]);

const everyKeyOf = (sections: readonly string[]): string[] => sections.flatMap((section) => [`${section}.*`, `${section}.*.*`]);

const NAMES_A_PROGRAM = 'git would start the program it names; the value given for the command names none';
const READ_LAST = 'git reads the value given for the command last, for every URL';

export const REPOSITORY_KEY_RULES: readonly RepositoryKeyRule[] = [
  ...overridden('program', NAMES_A_PROGRAM, [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', NO_PROGRAM],
    ['core.pager', 'cat'],
    ['core.editor', NO_EDITOR],
    ['core.sshCommand', NO_PROGRAM],
    ['core.askPass', NO_PROGRAM],
    ['core.gitProxy', NO_PROGRAM],
    ['core.alternateRefsCommand', ALTERNATE_REFS_DEFAULT],
    ['gpg.program', NO_PROGRAM],
    ['gpg.openpgp.program', NO_PROGRAM],
    ['gpg.ssh.program', NO_PROGRAM],
    ['gpg.x509.program', NO_PROGRAM],
    ['gpg.ssh.defaultKeyCommand', NO_PROGRAM],
    ['sequence.editor', NO_EDITOR],
    ['interactive.diffFilter', NO_PROGRAM],
    ['uploadpack.packObjectsHook', NO_PROGRAM],
  ]),
  ...scopedLike('program', `the credential comes from the call alone: ${READ_LAST}`, 'credential', [['helper', '']]),
  ...scopedLike('credential', `the prompt names the whole URL: ${READ_LAST}`, 'credential', [['useHttpPath', 'true']]),
  ...overridden('program', 'only the protocol of each destination of the call is allowed', [['protocol.allow', 'never']]),
  ...overridden(
    'protocol',
    'only the protocol of each destination of the call is allowed',
    GIT_PROTOCOLS.map((name): ConfigEntry => [`protocol.${name}.allow`, 'never']),
  ),
  ...perDestination('the transport of the call is set for the exact destination and in general', [
    ['sslVerify', 'true'],
    ['extraHeader', ''],
    ['curloptResolve', ''],
    ['followRedirects', 'initial'],
    ['cookieFile', ''],
    ['saveCookies', 'false'],
  ]),
  ...overridden('recursion', 'a fetch or a push here does not enter a submodule, whose configuration nothing has read', [
    ['fetch.recurseSubmodules', 'false'],
    ['submodule.recurse', 'false'],
    ['push.recurseSubmodules', 'no'],
  ]),
  ...refused('names a program git starts for the remote', ['remote.*.receivepack', 'remote.*.uploadpack', 'remote.*.vcs']),
  ...['insteadOf', 'pushInsteadOf'].map((variable): RepositoryKeyRule => ({
    key: `url.*.${variable.toLowerCase()}`,
    why: 'rewrites the destination; the command names each destination it reaches, as written and as resolved',
    verdict: 'refused',
    rewrite: [`url.${REWRITTEN_TO}.${variable}`, REWRITTEN_FROM],
  })),
  ...refused('changes who vouches for the remote and cannot be set aside for one command', ['http.sslcainfo', 'http.*.sslcainfo', 'http.sslcapath', 'http.*.sslcapath']),
  ...inert('the destination and the refs of a remote, which the operation reads, shows and names itself', [
    'remote.pushdefault',
    'remote.*.url',
    'remote.*.pushurl',
    'remote.*.fetch',
    'remote.*.push',
    'remote.*.tagopt',
    'remote.*.prune',
    'remote.*.prunetags',
    'remote.*.skipdefaultupdate',
    'remote.*.skipfetchall',
    'remote.*.promisor',
    'remote.*.partialclonefilter',
  ]),
  ...inert('branch tracking and what tools note on a branch', everyKeyOf(['branch'])),
  ...inert('the identity commits are written with', ['user.*', 'author.*', 'committer.*']),
  ...inert('how the repository is laid out and how files are handled on this machine', [
    'core.repositoryformatversion',
    'core.filemode',
    'core.bare',
    'core.logallrefupdates',
    'core.ignorecase',
    'core.precomposeunicode',
    'core.symlinks',
    'core.autocrlf',
    'core.eol',
    'core.safecrlf',
    'core.quotepath',
    'core.untrackedcache',
    'core.sparsecheckout',
    'core.sparsecheckoutcone',
    'core.commentchar',
    'core.abbrev',
    'core.excludesfile',
    'core.attributesfile',
    'core.whitespace',
    'core.bigfilethreshold',
    'core.compression',
    'core.loosecompression',
    'core.preloadindex',
    'core.fscache',
    'core.longpaths',
    'core.protecthfs',
    'core.protectntfs',
    'core.trustctime',
    'core.checkstat',
    'core.splitindex',
    'core.multipackindex',
    'core.commitgraph',
    'core.hidedotfiles',
    'core.sharedrepository',
    'core.worktree',
    'extensions.worktreeconfig',
    'extensions.objectformat',
    'extensions.refstorage',
    'extensions.partialclone',
  ]),
  ...inert(
    'read by commands that write commits, merge, compare or print, which a fetch or a push does not run',
    everyKeyOf(['init', 'commit', 'tag', 'pull', 'merge', 'rebase', 'diff', 'status', 'log', 'color', 'column', 'advice', 'format', 'apply', 'blame', 'grep', 'stash', 'rerere', 'gui']),
  ),
  ...inert('content filters run when files are checked out or added, which a fetch or a push does not do', ['filter.*.*', ...everyKeyOf(['lfs'])]),
  ...inert('housekeeping and storage tuning of the repository on this machine', everyKeyOf(['gc', 'maintenance', 'pack', 'index', 'feature'])),
  ...inert('how refs and objects are moved, with no program and no other destination', [
    'fetch.prune',
    'fetch.prunetags',
    'fetch.fsckobjects',
    'fetch.output',
    'fetch.parallel',
    'fetch.negotiationalgorithm',
    'fetch.writecommitgraph',
    'fetch.showforcedupdates',
    'push.default',
    'push.autosetupremote',
    'push.followtags',
    'push.usebitmaps',
    'push.useforceifincludes',
    'transfer.fsckobjects',
    'protocol.version',
    'http.postbuffer',
    'http.*.postbuffer',
    'http.version',
    'http.*.version',
    'gpg.format',
  ]),
  ...inert('where submodules are; a fetch or a push here does not enter them', ['submodule.active', 'submodule.*.url', 'submodule.*.active', 'submodule.*.update', 'submodule.*.branch', 'submodule.*.ignore']),
];

type KeyParts = { section: string; subsection: string | undefined; variable: string };

const partsOf = (key: string): KeyParts | undefined => {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first <= 0 || last === key.length - 1) return undefined;
  return { section: key.slice(0, first).toLowerCase(), subsection: first === last ? undefined : key.slice(first + 1, last), variable: key.slice(last + 1).toLowerCase() };
};

const ANY = '*';

type Pattern = { rule: RepositoryKeyRule; parts: KeyParts };

const PATTERNS: readonly Pattern[] = REPOSITORY_KEY_RULES.map((rule) => {
  const parts = partsOf(rule.key);
  if (parts === undefined) throw new Error(`the repository key rule ${rule.key} is not a configuration key`);
  return { rule, parts };
});

const subsectionMatches = (pattern: string | undefined, given: string | undefined): boolean => {
  if (pattern === undefined || given === undefined) return pattern === given;
  return pattern === ANY || pattern === given.toLowerCase();
};

export const repositoryKeyRuleOf = (key: string): RepositoryKeyRule | undefined => {
  const given = partsOf(key);
  if (given === undefined) return undefined;
  const candidates = PATTERNS.filter(({ parts }) => parts.section === given.section && subsectionMatches(parts.subsection, given.subsection));
  const exact = candidates.find(({ parts }) => parts.variable === given.variable && parts.subsection !== ANY);
  const scoped = candidates.find(({ parts }) => parts.variable === given.variable);
  return (exact ?? scoped ?? candidates.find(({ parts }) => parts.variable === ANY))?.rule;
};

export const overridesOf = (groups: readonly OverrideGroup[]): ConfigEntry[] => {
  const entries = new Map<string, ConfigEntry>();
  for (const rule of REPOSITORY_KEY_RULES) {
    if (rule.verdict === 'overridden' && groups.includes(rule.group)) entries.set(rule.set[0], rule.set);
  }
  return [...entries.values()];
};

export const overrideOf = (key: string): ConfigEntry => {
  const rule = repositoryKeyRuleOf(key);
  if (rule?.verdict !== 'overridden') throw new Error(`no value is given for the configuration key ${key}`);
  return rule.set;
};

const LOCAL_DESTINATION = /^(file:\/\/|\/)/;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const HTTP_PROTOCOLS: readonly string[] = ['http', 'https'];
const ALLOWED = 'always';

const protocolOf = (destination: string): string | undefined => (LOCAL_DESTINATION.test(destination) ? 'file' : URL_SCHEME.exec(destination)?.[1]?.toLowerCase());

export const isHttpDestination = (destination: string): boolean => HTTP_PROTOCOLS.includes(protocolOf(destination) ?? '');

export type ProductSetEntry = { readonly entry: ConfigEntry; readonly rule: RepositoryKeyRule };

const ruleOfSet = (key: string): RepositoryKeyRule => {
  const rule = repositoryKeyRuleOf(key);
  if (rule === undefined) throw new Error(`the configuration key ${key} set for a network command has no rule`);
  return rule;
};

const setFor = (rule: RepositoryKeyRule, destinations: readonly string[], rewrites: readonly UrlRewrite[], needed: ReadonlySet<string | undefined>): ConfigEntry[] => {
  if (rule.verdict === 'refused') {
    const { rewrite } = rule;
    return rewrite === undefined ? [] : rewrites.map(({ from, to }): ConfigEntry => [rewrite[0].replace(REWRITTEN_TO, to), rewrite[1].replace(REWRITTEN_FROM, from)]);
  }
  if (rule.verdict === 'inert') return [];
  const [key, value] = rule.set;
  if (rule.group === 'protocol') return [[key, needed.has(key.split('.')[1]) ? ALLOWED : value]];
  return key.includes(DESTINATION_PLACE) ? destinations.filter(isHttpDestination).map((destination): ConfigEntry => [key.replace(DESTINATION_PLACE, destination), value]) : [[key, value]];
};

const NETWORK_GROUPS: readonly OverrideGroup[] = ['program', 'protocol', 'transport', 'recursion', 'credential'];

export const productSetEntriesOf = (destinations: readonly string[], rewrites: readonly UrlRewrite[]): ProductSetEntry[] => {
  const needed = new Set(destinations.map(protocolOf));
  const rewritten = [...destinations.filter(isHttpDestination).map((destination) => ({ from: destination, to: destination })), ...rewrites];
  const byKey = new Map<string, ConfigEntry>();
  const ordered = [
    ...REPOSITORY_KEY_RULES.filter((rule) => rule.verdict === 'overridden' && NETWORK_GROUPS.includes(rule.group)),
    ...REPOSITORY_KEY_RULES.filter((rule) => rule.verdict === 'refused'),
  ];
  for (const rule of ordered) for (const entry of setFor(rule, destinations, rewritten, needed)) byKey.set(`${entry[0]}\u0000${entry[1]}`, entry);
  return [...byKey.values()].map((entry) => ({ entry, rule: ruleOfSet(entry[0]) }));
};

export const UNKNOWN_KEY_REASON = 'is not a setting momonga knows to be without effect on a fetch or a push';
