# MomongaCode

MomongaCode is a coding agent for the terminal. It works with local and hosted models, keeps its own memory of your repositories, and runs tool calls under a permission system and an operating-system sandbox. The command is `momonga`.

![MomongaCode demo](docs/assets/momongacode-demo.gif)

## Installation

macOS and Linux:

```sh
curl -fsSL https://momongacode.com/install.sh | bash
```

Windows, in PowerShell:

```powershell
irm https://momongacode.com/install.ps1 | iex
```

Open an interactive session in a repository with `momonga`, or run a one-shot prompt with `momonga -p "explain what this repository does"`. See [Getting Started](https://momongacode.com/docs/getting-started) to configure a local server, subscription account, or API key.

## Why MomongaCode?

- **Adaptive Agent Memory & Context Orchestration.** Evidence-backed memories decay automatically, recall checks freshness against bound files and commits, and budgeted prompts with verified compaction keep long sessions accurate.
- **Agent Token Efficiency Engineering.** Prompt cache prefix stability, tool deferral, concise tool descriptions, output formatters, loop guidance, and observed capacity checks are on by default and measurable with `momonga eval`.
- **Capability-Aware System Prompt Architecture.** Deterministic, capability-driven prompts adapt to each server and model without model-name branches.
- **Output Clarity Engineering.** Switch response density with `/style` or revise technical answers and files against the codebase with `/polish`.
- **Safety, permissions, and verifiable completion.** Tool calls run under explicit permission rules, OS sandboxes (`sandbox-exec` on macOS, `bwrap` on Linux), formal rule checks (`momonga policy verify`), optional choice-only judging models (`system-one`), and post-turn verification conditions.

## Documentation

Full guides and reference documentation live on the official website:

- [Documentation & Guide](https://momongacode.com/docs/)
- [Configuration](https://momongacode.com/docs/configuration)
- [Judging models](https://momongacode.com/docs/judging-models)
- [CLI & Settings Reference](https://momongacode.com/docs/reference/)
- [Threat model](https://momongacode.com/docs/threat-model)

## Contributing

Pull requests on GitHub are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for source build and test instructions, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

MomongaCode is open source under the MIT License; see [`LICENSE`](LICENSE).

Release builds bundle ripgrep (MIT or Unlicense); see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Disclaimer

MomongaCode is provided "as is", without warranty of any kind. It executes commands and modifies files on your machine, and sends prompts, file contents, and tool outputs to the model servers you configure.

You are responsible for the models, permission rules, sandbox settings, and permission modes you choose, for any hosted model costs, and for reviewing the agent's actions. Models can make mistakes—do not enable `bypassPermissions` or `"sandbox": "none"` on machines or folders where an unintended command could cause irreversible harm.
