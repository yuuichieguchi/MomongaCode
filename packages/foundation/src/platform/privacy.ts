import fs from 'node:fs';
import { parseOutsideJson } from '../json-depth.ts';
import type { CommandRunner } from './command-runner.ts';
import { powershellArgs, powershellLiteral, powershellPath } from './windows-scripts.ts';

export type PrivacyKind = 'directory' | 'file';

export const PRIVATE_MODE = { directory: 0o700, file: 0o600 } as const;

export const modeIsPrivate = (stat: { mode: number }, kind: PrivacyKind, platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32' || (stat.mode & 0o777) === PRIVATE_MODE[kind];

export type OwnerProblem = { found: number; expected: number };

export const ownerProblem = (
  stat: { uid: number },
  platform: NodeJS.Platform = process.platform,
  currentUid: number | undefined = process.getuid?.(),
): OwnerProblem | undefined => {
  if (platform === 'win32') return undefined;
  if (currentUid === undefined) throw new Error('process.getuid is required to verify the owner');
  return stat.uid === currentUid ? undefined : { found: stat.uid, expected: currentUid };
};

export const assertPrivateRegularFile = (stat: { mode: number; uid: number; isFile(): boolean }, description: string): void => {
  if (!stat.isFile()) throw new Error(`${description} is not a regular file`);
  const owner = ownerProblem(stat);
  if (owner !== undefined) throw new Error(`${description} is owned by uid ${owner.found}, but the current user is uid ${owner.expected}`);
  if (!modeIsPrivate(stat, 'file')) throw new Error(`${description} must have mode 0600, found ${(stat.mode & 0o777).toString(8).padStart(4, '0')}`);
};

export const noFollowFlag = (platform: NodeJS.Platform = process.platform): number => (platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);

export const directoryFlag = (platform: NodeJS.Platform = process.platform): number => (platform === 'win32' ? 0 : fs.constants.O_DIRECTORY);

export type AclReport = { owner: string; me: string; system: string; administrators: string; foreign: readonly string[] };

export const aclProblem = (report: AclReport): string | undefined => {
  if (report.owner !== report.me && report.owner !== report.administrators) return `owned by ${report.owner}, not by the current user ${report.me}`;
  if (report.foreign.length > 0) return `grants access to ${report.foreign.join(', ')}`;
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseAclReport = (text: string): AclReport => {
  const parsed: unknown = parseOutsideJson(text);
  if (!isRecord(parsed)) throw new Error(`ACL report is not an object: ${text}`);
  const text_ = (name: string): string => {
    const value = parsed[name];
    if (typeof value !== 'string' || value === '') throw new Error(`ACL report has no ${name}: ${text}`);
    return value;
  };
  const foreignRaw = parsed['foreign'];
  const foreign = foreignRaw === null || foreignRaw === undefined ? [] : Array.isArray(foreignRaw) ? foreignRaw : [foreignRaw];
  if (!foreign.every((entry): entry is string => typeof entry === 'string')) throw new Error(`ACL report foreign list is not strings: ${text}`);
  return { owner: text_('owner'), me: text_('me'), system: text_('system'), administrators: text_('administrators'), foreign };
};

const SID_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$system = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)',
  '$admins = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)',
];

const REPORT_BODY = [
  '$acl = Get-Acl -LiteralPath $path',
  '$allowed = @($me.Value, $system.Value, $admins.Value)',
  '$foreign = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq "Allow" -and $allowed -notcontains $_.IdentityReference.Value } | ForEach-Object { $_.IdentityReference.Value })',
  '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
  'ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ owner = $owner; me = $me.Value; system = $system.Value; administrators = $admins.Value; foreign = $foreign })',
];

export const aclReportScript = (directory: string): string => [...SID_PRELUDE, `$path = ${powershellLiteral(directory)}`, ...REPORT_BODY].join('\n');

export const aclRestrictScript = (directory: string): string =>
  [
    ...SID_PRELUDE,
    `$path = ${powershellLiteral(directory)}`,
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit"',
    '$none = [System.Security.AccessControl.PropagationFlags]::None',
    'foreach ($sid in @($me, $system)) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, "FullControl", $inherit, $none, "Allow"))) }',
    'Set-Acl -LiteralPath $path -AclObject $acl',
    ...REPORT_BODY,
  ].join('\n');

export class PrivateTreeError extends Error {
  readonly directory: string;

  constructor(directory: string, problem: string) {
    super(`${directory} is not private: it ${problem}`);
    this.name = 'PrivateTreeError';
    this.directory = directory;
  }
}

export type WindowsPrivacyPorts = { run: CommandRunner; env: Readonly<Record<string, string | undefined>>; signal?: AbortSignal | undefined };

export const ensureWindowsPrivateTree = async (directory: string, { run, env, signal }: WindowsPrivacyPorts): Promise<void> => {
  const environment = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const execute = async (script: string): Promise<AclReport> => {
    const result = await run(powershellPath(env), powershellArgs(script), { env: environment, signal });
    if (result.exitCode !== 0) throw new Error(`powershell exited with ${result.exitCode}: ${result.stderr.trim()}`);
    return parseAclReport(result.stdout);
  };
  if (aclProblem(await execute(aclReportScript(directory))) === undefined) return;
  const problem = aclProblem(await execute(aclRestrictScript(directory)));
  if (problem !== undefined) throw new PrivateTreeError(directory, problem);
};
