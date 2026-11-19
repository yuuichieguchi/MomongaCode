export const SITE_ORIGIN = 'https://momongacode.com';

export const SITE_BRANCH = 'site';

export type Installer = { file: string; source: string; tab: string; language: string; command: string };

export const INSTALLERS: readonly Installer[] = [
  { file: 'install.sh', source: 'scripts/install.sh', tab: 'macOS and Linux', language: 'sh', command: `curl -fsSL ${SITE_ORIGIN}/install.sh | bash` },
  { file: 'install.ps1', source: 'scripts/install.ps1', tab: 'Windows, in PowerShell', language: 'powershell', command: `irm ${SITE_ORIGIN}/install.ps1 | iex` },
];

export const INSTALLER_CONTENT_TYPE = 'text/plain; charset=utf-8';

const PRINTED: Readonly<Record<string, () => string>> = {
  'print-origin': () => SITE_ORIGIN,
  'print-branch': () => SITE_BRANCH,
  'print-installers': () => INSTALLERS.map((installer) => installer.file).join('\n'),
  'print-installer-content-type': () => INSTALLER_CONTENT_TYPE,
};

if (import.meta.main) {
  const command = process.argv[2] ?? '';
  const print = PRINTED[command];
  if (print === undefined) {
    process.stderr.write(`site-target.ts: unknown command '${command}'; known: ${Object.keys(PRINTED).join(', ')}\n`);
    process.exit(2);
  }
  process.stdout.write(`${print()}\n`);
}
