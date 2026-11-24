# Security Policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open [Report a vulnerability](https://github.com/yuuichieguchi/MomongaCode/security/advisories/new) on the Security tab of this repository. Do not open a public issue or pull request for a vulnerability.

A useful report includes:

- What the issue is and what it lets an attacker do.
- Steps to reproduce it, or a proof of concept, against the latest release or the current `main`.
- The version (`momonga --version`) or the commit, the operating system, and the settings that matter, such as `sandbox`, `sandboxNetwork` and the permission mode.
- Which bound stated in [site/docs/threat-model.md](site/docs/threat-model.md) (also on [momongacode.com/docs/threat-model](https://momongacode.com/docs/threat-model)) is crossed.

Reports are reviewed, and the disclosure of a confirmed vulnerability is coordinated with its reporter. MomongaCode has no bug bounty program.

## What is a vulnerability

[site/docs/threat-model.md](site/docs/threat-model.md) states the places where authority, a secret or untrusted text crosses a boundary of MomongaCode, the risks it accepts by design, and what still bounds each of them. A vulnerability is a way to make MomongaCode cross a bound that this document, [the documentation](https://momongacode.com/docs/) or [the reference](https://momongacode.com/docs/reference/) states. For example:

- A command that runs under Seatbelt or bubblewrap writes outside the places the sandbox allows, reads or writes a secret location or a path that a file deny rule covers, reaches a network it was not given, or connects to a Unix socket that is not listed in `sandboxUnixSockets.allow`.
- A process that MomongaCode starts reads or changes the home of MomongaCode, its key store, its programs or its temporary folder, under Seatbelt on macOS or with bubblewrap installed on Linux.
- A route that acts for the person is served without the person's capability, or the credential route of the supervisor is served without its capability.
- A folder that is not trusted makes MomongaCode load its settings or run something they name.
- A hook group, a mandate file, a server of `.mcp.json` or an agent of a trusted folder is used before you approve it.
- A project or local settings file sets a key that the documentation says it cannot set.
- A credential reaches the model where the threat model says it is redacted.
- `momonga update` or an installer installs an executable whose checksum or signature does not verify.

## What is not a vulnerability

The risks that MomongaCode accepts by design, as the threat model and the documentation state them, are not vulnerabilities:

- A `Bash(...)` allow or deny rule matches the command text literally, so an allowed program can start another program through its options.
- A model follows instructions written in untrusted text, or the classifier of `auto` mode is misled, and no bound above is crossed.
- Another process of the same account reads the capability file or reaches the sockets or the Windows named pipes of MomongaCode.
- A setting or an answer of yours lifts a bound: `"sandbox": "none"`, `sandboxNetwork: allow`, `bypassPermissions`, the network `open` given to a command, or an allow rule that is wider than you meant. A bound that the threat model says holds under that setting, such as the secret locations under `bypassPermissions`, is still a bound.
- Windows has no sandbox in this release.
- The limits of the MCP credential redaction that the threat model lists.
- A model request is sent twice.
- What the model servers you configure do with the content MomongaCode sends them.

A report about one of these is welcome as an ordinary issue or pull request.
