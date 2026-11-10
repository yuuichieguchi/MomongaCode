# Momonga Code

Momonga Code is a coding agent for the terminal. It works with local and hosted models, keeps its own memory of your projects, and runs tool calls under a permission system and an operating-system sandbox. The command is `momonga`.

No release has been published yet.

## 1. Installation

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/yuuichieguchi/MomongaCode/main/scripts/install.sh | bash
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/yuuichieguchi/MomongaCode/main/scripts/install.ps1 | iex
```

## 2. Why Momonga Code?

Momonga Code puts particular effort into the following areas and aims to be No. 1 in them.

- **Adaptive Agent Memory & Context Orchestration**
- **Agent Token Efficiency Engineering**

### Adaptive Agent Memory & Context Orchestration

In Momonga Code, memory and context are built by the runtime from recorded events, not left to the model alone.

- Memories have a kind (`fact`, `episode`, `procedure`), a scope (user or project), a state (`active`, `candidate`, `archived`, `duplicate`, `rejected`), and optional evidence: a file with its SHA-256, a commit, or a check that was run. A memory that is bound to a file is shown as stale once the file changes.
- Memories the agent proposes wait in a review queue until you accept or reject them. Duplicates are marked, replaced notes keep a history, and active memories whose file evidence is stale, or that are bound to no file, are archived once they have not been kept or used for `memory.forgetAfterDays` (default 90).
- With `context.adaptiveBudget` (default `false`), the share of the context budget given to memories is adjusted every 20 runs of a folder from how many injected memories were used: halved when fewer than a quarter were used, doubled when more than three quarters were used and memories had to be dropped, within 1/16 to 1/2 of the budget (starting at 1/4).
- The context for each model call is assembled under a token budget from the instruction files, rules, memories, active skills, and history. When history is compacted, the summary is checked against the material it replaces, and the agent can search and read the earlier history again with the `HistorySearch` and `HistoryRead` tools.
- Standing rules (`momonga rule`) bind a folder or every folder. A rule given with `--deny` or `--ask` is enforced by the permission system rather than only written into the prompt.
- `momonga context improve` samples candidate compaction guidelines, benchmarks them against the guideline in force, and writes the outcome to a file. Nothing is stored until you adopt a guideline with `momonga context guideline adopt`.

### Agent Token Efficiency Engineering

Each token-saving mechanism is a setting, and `momonga eval` measures a change against a baseline before it is trusted.

- **Prompt cache.** `context.cachePrefix` keeps the leading part of each request stable between calls in a run, so a provider's prompt cache can apply. The runtime records which events may change the prefix and reports a notice when a request keeps fewer leading items than those events allow.
- **Tool deferral.** `tools.deferral` replaces the definitions of tools that were offered in each of the last 20 runs of a folder and called in none of them (nothing is deferred before a folder has 20 runs) with a one-line catalog and a `LoadTools` tool. A tool's full definition is sent only after the model loads it.
- **Concise tool descriptions.** `tools.conciseDescriptions`.
- **Output formatters.** `context.outputFormatters` takes any of `log`, `json`, `grep`, `identicalOutput` to shrink tool output before it enters the context.
- **Loop guidance.** `context.loopGuidance` warns the model, with the repeated call and the commands that failed, before a run that repeats the same call is stopped.
- **Observed capacity.** `context.observedCapacity`.
- **Cost visibility.** `momonga cost --breakdown` shows what the requests were made of, the billed tokens by kind, the cache hit ratio, the timing, and the cost.
- **Measurement.** `momonga eval context <dataset>` runs a golden dataset and reports metrics; `momonga eval compare <baseline> <candidate> --gate token` judges a token policy against a baseline report.

All of these settings are off by default (see Configuration).

## 3. Getting Started

1. Declare a model target and an alias in your user settings file, `~/.momonga/settings.json` (see Configuration for a complete example).
2. Check that it is seen:

   ```sh
   momonga models
   ```

   `momonga models detect` asks the usual local addresses, and any address you name, which model server answers there. It writes nothing.
3. Start an interactive session in a project folder:

   ```sh
   cd your-project
   momonga
   ```

   The first time you open a folder, Momonga Code asks whether you trust it. If you answer no, it continues without the folder's project settings.
4. Or run a single prompt without the terminal UI:

   ```sh
   momonga -p "explain what this repository does"
   ```

The first command starts a background daemon if it is not running. `momonga daemon status` shows it.

## 4. Features

- **Terminal UI and headless mode.** An interactive session, or `-p/--print` with `--output-format text|json|stream-json`.
- **Models.** Targets for Apple's `fm`, chat-completions servers, Open Responses servers, Anthropic, and Ollama. An alias names one target or an ordered list of targets. `momonga gateway probe <target>` measures a target's capabilities and records the result.
- **Built-in tools.** `Bash` (with `BashOutput` and `KillBash` for background jobs), `Read`, `Write`, `Edit`, `Glob`, `Grep`, `ReadOutput`, `UpdatePlan`, `MemorySave`, `MemorySearch`, `HistorySearch`, `HistoryRead`, `RulePropose`, `Agent` (subagents), and `activate_skill`.
- **Permission modes.** `manual`, `acceptEdits`, `plan`, `auto`, and `bypassPermissions`. Rules are written as `Tool(specifier)`, for example `Bash(npm test:*)`, and set in `permissions.allow`, `permissions.ask`, and `permissions.deny`. `momonga approve` lists and resolves pending approvals with `allow_once`, `allow_always`, `reject_once`, or `reject_always`. A `Bash(...)` allow rule matches the command text literally, so it also allows options that run other programs; see [docs/threat-model.md](docs/threat-model.md) for what still bounds such a command.
- **Policy verification.** `momonga policy verify` checks the rules of the folder: that no allow rule gets around a deny rule, that no rule leaves a route to secrets, and that every rule can take effect. It states what is proved and what is not.
- **Auto mode.** `momonga auto-mode` measures how well a model judges approvals for auto mode. Auto mode is honored only from user settings or the command line.
- **Sandbox.** Bash runs under Seatbelt on macOS and bubblewrap on Linux. Windows has no sandbox in this release: Bash asks before every command.
- **Memory and rules.** `momonga memory` and `momonga rule` (see section 2).
- **Skills and agents.** Skills are `SKILL.md` files found in `.momonga/skills` and `.agents/skills` of the project and in `~/.momonga/skills` and `~/.agents/skills`. Custom agents are read from `.momonga/agents` directories. Project skills are loaded only for trusted folders.
- **MCP.** Servers over stdio or HTTP with OAuth. `momonga mcp list` and `momonga mcp login <server>`. Pending MCP input requests are handled with `momonga elicit`.
- **Hooks.** Commands run on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, and `SessionStart`. A hook that exits with code 2 blocks.
- **Editor integration.** `momonga acp` speaks the Agent Client Protocol on standard input and output.
- **Observability.** `momonga trace` shows the model and tool spans of a run, `momonga cost` shows what it cost, and an OTLP endpoint can be configured under `telemetry.otlp`.
- **Background jobs and runs.** `momonga status`, `momonga jobs`, `momonga attach`, and `momonga cancel`.

## 5. Usage

```text
momonga [options] [prompt]
```

| Option | Meaning |
| --- | --- |
| `-p, --print <prompt>` | Run the prompt without a terminal UI and print the result |
| `--output-format <format>` | `text`, `json`, or `stream-json` (for `--print` and `attach`) |
| `--permission-mode <mode>` | `manual`, `acceptEdits`, `plan`, `auto`, or `bypassPermissions` |
| `--model <alias>` | The model alias of the session |
| `--dangerously-skip-permissions` | Run in `bypassPermissions` mode |
| `--skill <name>` | Run the prompt with this skill activated |
| `--image <path>` | Attach an image; repeat for several. Needs a model that declares image input |
| `--verbose` | Print tool activity to stderr |
| `-V, --version`, `-h, --help` | Version and help |

Commands:

| Command | Purpose |
| --- | --- |
| `attach [run-id]` | Follow a run until it ends (`--after <seq>`, `--output-format`, `--verbose`) |
| `approve [approval-id] [option]` | List pending approvals, show one, or resolve it |
| `cancel [run-id]` | Cancel a run |
| `status [run-id]` | Show a run, its subagent runs, and the approvals waiting in them (`--json`) |
| `jobs [session-id]` | List background jobs of a session (`--json`) |
| `trace [run-id]` | Show the model and tool spans of a run (`--json`) |
| `cost [run-id]` | Show model cost (`--session <id>`, `--all`, `--breakdown`, `--json`) |
| `models` | List the aliases with the capabilities their targets declare (`--json`); `models detect [url...]` finds local model servers |
| `gateway probe <target>` | Measure an `fm`, chat-completions, or Ollama target and record the result (`--fm-binary <path>`, `--samples <count>`) |
| `memory add\|list\|show\|history\|delete\|review\|restore\|promote` | Manage memories. `add` takes `--kind`, `--path`, `--user`; `review` has `accept <id>` and `reject <id>`; `promote <id>` writes an accepted procedure memory as a skill |
| `rule add\|list\|retire\|history` | Standing rules. `add <target> <text...>` takes `--kind`, `--user`, `--path`, `--deny`, `--ask`, `--supersedes`, `--until` |
| `policy verify` | Check the permission rules of the folder (`--json`, `--mode <mode>`, `--secret <path>`) |
| `auto-mode` | Measure or show how well a model judges approvals for auto mode |
| `mcp list`, `mcp login <server>` | Inspect and authorize MCP servers (`login --no-browser` prints the URL) |
| `elicit [input-id]` | Answer pending MCP input requests (`--accept`, `--decline`, `--cancel`, `--set name=value`, `--responses <json>`) |
| `secret set <name>` | Store a secret in the platform secret store; the value is read from the terminal |
| `context improve`, `context guideline` | Improve and manage the compaction guideline |
| `eval <dataset>`, `eval context <dataset>`, `eval compare <baseline> <candidate>` | Run and compare golden datasets and context reports (`--gate context\|token`) |
| `daemon start\|status\|stop` | Manage the background daemon |
| `acp` | Agent Client Protocol on standard input and output |
| `update [--check]` | Update the executable |

Run `momonga <command> --help` for the options of each command.

`momonga update` replaces the executable with the latest release after verifying its checksum and signature. `momonga update --check` only reports whether a newer release exists. If the daemon was running, both `momonga update` and the automatic update restart it on the new version: each run finishes its current step, then continues in the new daemon. A session opened before the update is told that momonga was updated and to reopen it. If the restart fails, the new version stays installed and the message says what to run.

A release build also checks for updates in the background, at most once every 24 hours. When it starts a command other than `update` and the internal ones, it runs the check in a detached process and, if a newer release exists, installs it on its own. The installation verifies the release's signed checksum list, the executable's sha256 and, where the build pins an Apple Team ID, its Developer ID signature, and it runs the new executable with `--version` before it replaces the file. If the check or the installation fails, nothing is replaced. Once the new executable is in place, a running daemon is restarted on it as described above, and a session that was already open keeps the old one until it is reopened. Before a later command runs, `momonga` prints a one-line notice once (on standard error, or in the interactive session's notices) that the update was installed or that the check failed. Set `"autoUpdates": false` in the user settings to turn the background check and its notices off; it is read only from user settings. A build run from source never updates itself.

Inside the interactive session, slash commands include `/help`, `/clear`, `/exit`, `/mode`, `/model`, `/rule`, `/memory`, `/auto-mode`, and `/cost`, `/status`, `/jobs`, `/trace`, `/mcp`, `/context`, `/policy`, `/models`, `/gateway`, which run the command of the same name. `/help` lists the rest.

## 6. Configuration

### Settings files

| File | Scope |
| --- | --- |
| `~/.momonga/settings.json` | User settings. Everything can be set here |
| `<project>/.momonga/settings.json` | Project settings, read only for trusted folders |
| `~/.momonga/projects/<hash>/settings.local.json` | Local settings for one project, kept outside the repository |
| `<project>/.mcp.json` | Project MCP servers |

Project and local settings cannot set `models`, `credentials`, `mcpServers`, `sandbox`, `telemetry`, `pricing`, `autoUpdates`, or `autoMode`; those keys are discarded with a warning. They can set `permissions.defaultMode` only to modes other than `bypassPermissions` and `auto`. In `env`, only a short allowlist of names is kept. Unknown keys are ignored with a warning.

### Model targets and aliases

A target is declared under `models.targets` with an `adapter`: `fm`, `chat-completions`, `open-responses`, `anthropic`, or `ollama`. An alias under `models.aliases` is a target name or an ordered list of target names. The alias `default` is used when you name none; if it is missing, the first target becomes `default` with a warning.

Credentials are declared by reference and never written into the file:

- `apiKeyEnv` names an environment variable that holds the key.
- `apiKeySecret` names an entry in the platform secret store, which you fill with `momonga secret set <name>`.
- `anthropic` targets need exactly one of the two. `chat-completions` and `open-responses` targets accept at most one. `ollama` and `fm` targets take none.

Example:

```json
{
  "models": {
    "targets": {
      "local": {
        "adapter": "ollama",
        "model": "your-model-name",
        "baseUrl": "http://127.0.0.1:11434",
        "capabilities": { "contextWindow": 32768, "maxOutputTokens": 4096 }
      },
      "hosted": {
        "adapter": "chat-completions",
        "provider": "example",
        "model": "example-model",
        "baseUrl": "https://api.example.com/v1",
        "apiKeyEnv": "EXAMPLE_API_KEY",
        "capabilities": { "contextWindow": 128000, "maxOutputTokens": 8192 }
      },
      "apple": { "adapter": "fm" }
    },
    "aliases": {
      "default": "local",
      "cloud": ["hosted", "local"]
    },
    "billingChanges": [{ "from": "metered", "to": "local", "alias": "cloud" }]
  },
  "permissions": {
    "defaultMode": "manual",
    "allow": ["Bash(npm test:*)"],
    "deny": ["Bash(rm:*)"]
  }
}
```

A list falls from a metered target to a local one, or the reverse, only when `models.billingChanges` allows that change; otherwise a warning is shown.

The values in `capabilities` are what you declare for your model; set them to the real values for the model you use. `momonga gateway probe <target>` measures a target and records the result.

Other keys under `models`: `roles` (an alias for `compaction`, `reflection`, or `analysis` calls), `dialects`, `billingChanges`, `headersTimeoutMs`, and `idleTimeoutMs`. A target can also set `billing`, `maxConcurrency`, and `admissionTimeoutMs`.

### Permission rules

In the example above, `Bash(npm test:*)` allows every command whose first words are `npm test`, with any options after them. A rule matches only when its words are the first words of the command, with nothing between them: `git -c core.pager=<program> log` does not match `Bash(git log:*)`, but it does match `Bash(git:*)`.

A `Bash(...)` allow rule matches the command text literally, as in Claude Code, and does not check what the options of the program do. So it also allows options that make the program run another program, such as `npm test --script-shell=<program>` under `Bash(npm test:*)`, `find . -exec <program> {} \;` under `Bash(find:*)`, or `git -c core.pager=<program> log` under `Bash(git:*)`. Write an allow rule only for a program whose every option you accept.

A command allowed this way still runs inside the sandbox. Network access is denied. File deny rules, such as `Read(...)` and `Edit(...)`, are enforced by the operating system, so no program the command starts can read or write a denied path. The command can write only where the sandbox allows writes. A `Bash(...)` deny rule, such as `Bash(rm:*)` in the example, matches only the command text, so it does not stop a program that an allowed command starts through an option.

With `"sandbox": "none"` none of these bounds apply, so an allow rule no longer lets a command run without approval: Bash asks before every command, and in `auto` mode the classifier decides.

[docs/threat-model.md](docs/threat-model.md) states these and the other risks that Momonga Code accepts by design.

### Other settings

| Key | Meaning |
| --- | --- |
| `permissions.defaultMode`, `allow`, `ask`, `deny`, `additionalDirectories` | Permission mode, rules, and extra directories |
| `sandbox` | `seatbelt`, `bubblewrap`, or `none`. Default: `seatbelt` on macOS, `bubblewrap` on Linux, `none` elsewhere. With `none`, Bash asks before every command |
| `env` | Environment variables for sessions |
| `credentials` | `env`, `keep`, `valuePatterns`: which environment variables and values are treated as credentials |
| `hooks` | Hook commands by event, with an optional `matcher` and `timeout` |
| `mcpServers` | User MCP servers (`stdio` with `command`, `args`, `env`, `cwd`; or `http` with `url`, `headers`, `oauth`) |
| `enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers` | Which servers of a project `.mcp.json` are used |
| `autoMode.classifier` | The alias that judges approvals in auto mode |
| `memory.reflection.enabled` (default `false`), `memory.reflection.maxTokens` | Let the agent propose memories after a run |
| `memory.forgetAfterDays` | Default 90 |
| `memory.repositoryFacts` (default `false`) | Propose a procedure memory from a verification command that passed in a verified run |
| `verification.commands`, `verification.manifests` | Commands (default `npm test`, `pnpm test`, `yarn test`, `cargo test`, `pytest`, `go test ./...`, `swift test`, `make test`) and manifest files that count as verification |
| `context.adaptiveBudget` (default `false`) | Adjust the memory share of the context budget (see section 2) |
| `context.cachePrefix`, `context.outputFormatters`, `context.loopGuidance`, `context.observedCapacity` | Token settings (see section 2). All off by default |
| `tools.deferral`, `tools.conciseDescriptions` | Token settings (see section 2). Both off by default |
| `pricing` | Per-million-token prices by provider and model, for `momonga cost` |
| `telemetry.otlp.endpoint`, `telemetry.otlp.headers`, `telemetry.captureMessageContent`, `telemetry.contentRetentionDays` | OTLP export. Retention default 30 days |
| `autoUpdates` | Boolean |

Momonga Code stores its data under `~/.momonga` (settings, `state/` databases, `logs/`, `skills/`, `agents/`, and per-project data).

Instruction files named `AGENTS.md` are read into the context.

### Installer options

You set nothing. The install command in section 1 works from the first release on, once the repository is public: no release has been published yet, and the repository is private until the release, so until then there is nothing to download.

The script downloads `SHA256SUMS` and `SHA256SUMS.sig` from the latest GitHub release of `yuuichieguchi/MomongaCode`, verifies the signature with `ssh-keygen` against the release public key, checks the SHA-256 of the executable, and only then installs it. Nothing is installed if a check fails. `ssh-keygen` must be available; on Windows that means the OpenSSH Client optional feature.

All are optional environment variables read by both installers:

| Variable | Meaning |
| --- | --- |
| `MOMONGA_REPO` | `<owner>/<repo>` of the GitHub repository to download from. Default: `yuuichieguchi/MomongaCode`. Ignored when `MOMONGA_RELEASE_BASE_URL` is set |
| `MOMONGA_VERSION` | Install this version (`v<version>` release) instead of the latest. Ignored when `MOMONGA_RELEASE_BASE_URL` is set |
| `MOMONGA_RELEASE_BASE_URL` | Download from this location instead of GitHub. It must be `https`; plain `http` is accepted only on the loopback interface |
| `MOMONGA_RELEASE_PUBLIC_KEY` | The release signing key (an `ssh-ed25519` line), used instead of the key embedded in the installer |
| `MOMONGA_INSTALL_PREFIX` | Install location. Default: `~/.local` on macOS and Linux (the executable goes to `<prefix>/bin/momonga`); `%LOCALAPPDATA%\Programs\momonga` on Windows (the executable is `momonga.exe` in that directory) |
| `MOMONGA_MODIFY_PATH` | Set to `0` to leave your PATH alone |

The installers change your PATH only when the install directory is missing from it (`install.sh` checks the PATH of the running shell, `install.ps1` the user PATH):

- `install.sh` adds one marked block to a shell startup file: `.zshrc` (under `ZDOTDIR` if set) for zsh, the first existing of `.bashrc`, `.bash_profile`, `.profile` (else `.bashrc`) for bash, `~/.config/fish/config.fish` (with `fish_add_path`) for fish, and `~/.profile` for any other shell. Running the installer again updates that block in place and prints a message about it. When the install directory is already on the PATH of the running shell, it changes nothing and prints nothing about PATH.
- `install.ps1` appends the install directory to the user PATH.
- With `MOMONGA_MODIFY_PATH=0`, neither script changes anything and both print the command to run in the current shell instead.

## 7. Architecture

Momonga Code is an npm workspace of packages under `packages/`. The `momonga` command is a client; the work is done by background processes.

- **Client.** `packages/cli` (command line, terminal UI, ACP server). It starts and talks to the daemon.
- **Supervisor.** `packages/supervisor` runs the daemon: it starts, restarts, and stops two child processes, the gateway and the runtime. A settings change applies in place: each child reads the settings per operation, and no child is restarted for it.
- **Runtime.** `packages/runtime` runs sessions, runs, and the model and tool loop. It builds each request with `packages/context`, applies `packages/policy` to tool calls, executes tools from `packages/tools` inside `packages/sandbox`, and records everything in `packages/store`.
- **Gateway.** `packages/gateway` is the one place that talks to models. It has adapters for `fm`, chat-completions, Open Responses, Anthropic, and Ollama, plus routing, retry, admission, and probing.
- **Store.** `packages/store` holds runs, events, approvals, memories, rules, and jobs in databases under `~/.momonga/state`.
- **Context.** `packages/context` builds the context under a token budget, compacts history, and formats tool output.
- **Memory.** `packages/memory` holds the logic for memory validity, recall order, deduplication, forgetting, and the memory budget share.
- **Tools.** `packages/tools` defines the built-in tools and executes tool calls. `packages/skills` and `packages/agents` load skills and custom agents. `packages/mcp` connects MCP servers.
- **Policy.** `packages/policy` decides whether a tool call is allowed, from the permission rules, the parsed command, and the paths it touches.
- **Sandbox.** `packages/sandbox` runs commands under Seatbelt or bubblewrap.
- **Configuration.** `packages/config` defines the settings schema and merges the user, project, and local layers.
- **Shared.** `packages/protocol` (types, constants, wire formats), `packages/foundation` (paths, locks, platform code, credentials), `packages/observability` (traces, cost, OTLP), `packages/reliability` (reliability reports).
- **Verification and evaluation.** `packages/verify` (rule verification with Z3), `packages/eval` (datasets, reports, comparison), `packages/testkit` (fakes for tests).

The formal models of the state machines are TLA+ specifications in `specs/tla/`, checked with TLC in the test suite.

## 8. Requirements

- **Operating systems.** macOS on Apple silicon (arm64), Linux on x86_64 and aarch64, and Windows on x64 are the targets of the installers. CI runs on macOS, Linux (x86_64), and Windows.
- **Node.js.** Only for building and developing from source: `>=24.22.1` (the `engines` field of `package.json`). CI uses the version in `.node-version`.
- **Sandbox.**
  - macOS: `sandbox-exec` (Seatbelt).
  - Linux: `bwrap` (bubblewrap), which must be able to create a sandbox on the host. If it is missing or cannot, the runtime refuses to start and tells you to set `"sandbox": "none"`.
  - Windows: no sandbox; `"sandbox": "none"` is the default and Bash asks before every command.
- **Bash.** The Bash tool needs `/bin/bash` on macOS, `/bin/bash` or `/usr/bin/bash` on Linux, and Git for Windows (`bin\bash.exe` next to a `git.exe` on PATH) on Windows.
- **Installers.** `curl` and `ssh-keygen` on macOS and Linux; `ssh-keygen` (OpenSSH Client) on Windows.
- **A model.** A local server (for example Ollama), Apple's `fm`, or a hosted API that you have credentials for.

## 9. Contributing

Contributions are welcome through pull requests on GitHub.

```sh
npm ci
npm ci --prefix compliance/open-responses
npm run typecheck
npm test
npm run test:e2e
npm run test:packaging
```

- `npm test` runs the unit suite, including the TLA+ models and the Z3 proofs. TLC needs Java 8 or later and a pinned jar; fetch it with `scripts/tlc.sh --fetch-jar`. The Z3 proofs run through the `z3-solver` dependency of `packages/verify`.
- `npm run test:tlc-deep` runs the deep tier of the TLA+ configurations, which takes much longer.
- On Windows, CI runs the unit suite without the TLC tier, which needs bash, `ps`, and `/usr/bin`.
- On Linux, tests that use the sandbox need bubblewrap installed.
- Add or update tests with every change. Behaviour that is described by a TLA+ model in `specs/tla/` is changed in the model and in the code together.

### Building from source

```sh
npm ci
npm run bundle
node packages/cli/dist/main.js --help
```

Building a release executable is done with `npm run sea` (see `scripts/sea.ts`).

## 10. License

Momonga Code is open source under the MIT License. See the [`LICENSE`](LICENSE) file.

Bundles ripgrep (MIT or Unlicense); see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## 11. Disclaimer

Momonga Code is provided as is, without warranty of any kind. It runs commands and edits files on your machine, and it sends the content of your prompts, files, and tool output to the model targets you configure. You are responsible for the models, targets, permission rules, sandbox setting, and permission mode you choose, for the cost of any hosted model you use, and for reviewing what the agent does. A model can make mistakes. Do not use `bypassPermissions` mode or `"sandbox": "none"` on a machine or in a folder where an unwanted command could cause harm you cannot undo.
