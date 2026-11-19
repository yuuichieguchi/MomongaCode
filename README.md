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

Then add a model and run a first prompt, as section 3 shows.

## 2. Why Momonga Code?

Momonga Code puts particular effort into the following areas and aims to be No. 1 in them.

- **Adaptive Agent Memory & Context Orchestration**
- **Agent Token Efficiency Engineering**

### Adaptive Agent Memory & Context Orchestration

In Momonga Code, memory and context are built by the runtime from recorded events, not left to the model alone.

- Memories have a kind (`fact`, `episode`, `procedure`), a scope (user or project), a state (`active`, `candidate`, `archived`, `duplicate`, `rejected`), and optional evidence: a file with its SHA-256, a commit, or a check that was run. A memory that is bound to a file is shown as stale once the file changes.
- Memories the agent proposes wait in a review queue until you accept or reject them. Duplicates are marked, replaced notes keep a history, and active memories whose file evidence is stale, or that are bound to no file, are archived once they have not been kept or used for `memory.forgetAfterDays` (default 90).
- The share of the context budget given to memories is adjusted every 20 runs of a folder from how many injected memories were used: halved when fewer than a quarter were used, doubled when more than three quarters were used and memories had to be dropped, within 1/16 to 1/2 of the budget (starting at 1/4). On by default; turn off with `context.adaptiveBudget: false`.
- The context for each model call is assembled under a token budget from the instruction files, rules, memories, active skills, and history. When history is compacted, the summary is checked against the material it replaces, and the agent can search and read the earlier history again with the `HistorySearch` and `HistoryRead` tools.
- Standing rules (`momonga rule`) bind a folder or every folder. A rule given with `--deny` or `--ask` is enforced by the permission system rather than only written into the prompt.
- `momonga context improve` samples candidate compaction guidelines, benchmarks them against the guideline in force, and writes the outcome to a file. Nothing is stored until you adopt a guideline with `momonga context guideline adopt`.

### Agent Token Efficiency Engineering

Every token-saving mechanism is on by default; each has a setting only so you can turn it off, and `momonga eval` measures it against a base with it off.

- **Prompt cache.** On by default; turn off with `context.cachePrefix: false`. It keeps the leading part of each request stable between calls in a run, so a provider's prompt cache can apply. The runtime records which events may change the prefix and reports a notice when a request keeps fewer leading items than those events allow.
- **Tool deferral.** On by default; turn off with `tools.deferral: false`. It replaces the definitions of tools that were offered in each of the last 20 runs of a folder and called in none of them (nothing is deferred before a folder has 20 runs) with a one-line catalog and a `LoadTools` tool. A tool's full definition is sent only after the model loads it.
- **Concise tool descriptions.** On by default; turn off with `tools.conciseDescriptions: false`.
- **Output formatters.** On by default with every formatter (`log`, `json`, `grep`, `identicalOutput`) shrinking tool output before it enters the context; turn some off by listing the rest in `context.outputFormatters`, or all with `[]`.
- **Loop guidance.** On by default; turn off with `context.loopGuidance: false`. It warns the model, with the repeated call and the commands that failed, before a run that repeats the same call is stopped.
- **Observed capacity.** On by default; turn off with `context.observedCapacity: false`.
- **Cost visibility.** `momonga cost --breakdown` shows what the requests were made of, the billed tokens by kind, the cache hit ratio, the timing, and the cost.
- **Measurement.** `momonga eval context <dataset>` runs a golden dataset and reports metrics; `momonga eval compare <baseline> <candidate> --gate token` judges the defaults against a base report built with `--settings packages/eval/policies/core-off.json` (every core feature off). `momonga eval yield <dataset> --model <model> --report <file>` runs paired sessions and judges whether reflection pays: what a later session saves if the candidates are accepted, with the charge of the reflection shown beside it.

All of these settings are on by default; each is turned off key by key (see Configuration).

## 3. Getting Started

Add one model by one of the three routes below, then run a prompt. The first command that needs the daemon starts it in the background; `momonga daemon status` shows it.

### A model server on this computer

1. Start a local model server, such as Ollama, and ask which servers answer and which models they list. This writes nothing:

   ```sh
   momonga models detect
   ```

2. Add one of the listed models by the name its server gives it. Without `--yes` the change is only shown:

   ```sh
   momonga models add --address http://127.0.0.1:11434 --model <own name> --yes
   ```

   An Ollama server reports the context window and the tool support of its models, so you do not give `--window`. For a server that does not report the window, or an address where no server answers, the command says so and writes nothing; give it with `--window <tokens>`.
3. Check that the model is seen:

   ```sh
   momonga models
   ```

### A subscription account

1. Sign in in the browser. `chatgpt` is the provider this release ships, so the command needs no provider name:

   ```sh
   momonga auth login
   ```

   A new account has no model yet, and the sign-in says what to run next. `momonga auth status` shows the saved accounts and their state.
2. List the models the account offers, and add one by its own name:

   ```sh
   momonga models catalog <account>
   momonga models add --plan chatgpt --account <account> --model <own name> --yes
   ```

In the interactive session, `/login` signs in and `/model` chooses one of the account's models. A sign-in starts only from `/login` or `momonga auth login`: the start screen takes no key while you type.

### An API key

1. Store the key in the platform secret store under a name you choose. The value is read from the terminal and never written to a settings file:

   ```sh
   momonga secret set <name>
   ```

2. Add the model of the server at its address:

   ```sh
   momonga models add --address <url> --api <api> --model <own name> --api-key-secret <name> --yes
   ```

   `--api` is the API of a server MomongaCode does not recognise by itself: `ollama`, `openai`, `anthropic`, or `responses`. Instead of a stored secret, `--api-key-env <NAME>` names an environment variable that holds the key; it must be set in the environment the daemon starts with.

A model that is paid for by use is measured only with your consent. Its first request is refused with the most requests, input tokens and output tokens the measurement can send, and with the command to run that gives the consent. The consent is kept for that model and that bound.

### The first prompt

```sh
cd your-repository
momonga -p "explain what this repository does"
```

Run `momonga` with no prompt to start an interactive session instead. The first interactive session in a folder asks whether you trust it. Until a folder is trusted, its own settings, and everything they could make MomongaCode run, are not loaded: `momonga -p`, `momonga attach`, and an editor through `momonga acp` run without them and say so in one line that names `momonga trust <folder>`. `momonga trust --set trusted` decides the current folder from a shell.

## 4. Features

- **Terminal UI and headless mode.** An interactive session, or `-p/--print` with `--output-format text|json|stream-json`.
- **Models.** Connections to Ollama, chat-completions servers, Open Responses servers, Anthropic, and server programs that Momonga Code starts itself, such as Apple's `fm`. A model is called by the name its server gives it. `models.fallback` lists the models tried next when a model cannot answer. `momonga gateway probe <model>` measures a model's capabilities and records the result.
- **Built-in tools.** `Bash` (with `BashOutput` and `KillBash` for background work), `Read`, `Write`, `Edit`, `Glob`, `Grep`, `ReadOutput`, `UpdatePlan`, `MemorySave`, `MemorySearch`, `HistorySearch`, `HistoryRead`, `RulePropose`, `Agent` (subagents: the general subagent `general-purpose` is built in and needs no setup), `LoadTools`, and `activate_skill`, and the operations tools for Git, pull requests and issues (`GitStage`, `GitCommit`, `GitPush` and the others): each states what it changes, and the approval names it. [docs/reference.md](docs/reference.md) lists every tool.
- **Permission modes.** The mode decides what a call that no rule decides does:
  - `manual` asks before every call that changes something or reaches the network;
  - `acceptEdits` also allows, without asking, edits and file-system commands inside the workspace;
  - `plan` refuses every tool that writes or changes something and asks before a command that is not read-only, so the model reads and proposes a plan;
  - `auto` lets a classifier model decide each such call in your place, as the next item says;
  - `bypassPermissions` allows every call that no deny rule matches and asks nobody.

  In every mode a deny rule still denies, the secret locations stay denied (see Permission rules), and a command that removes the workspace is asked of you except in `bypassPermissions`. Rules are written as `Tool(specifier)` and set in `permissions.allow`, `permissions.ask`, and `permissions.deny` (section 6). `momonga approve` lists and resolves pending approvals with `allow_once`, `allow_always`, `reject_once`, or `reject_always`.
- **Policy verification.** `momonga policy verify` asks the daemon to check the rules of the folder: that no allow rule gets around a deny rule, that no rule leaves a route to secrets, and that every rule can take effect. It states what is proved and what is not, and lists a rule that is redundant, shadowed by another, or cannot be reached as a note; a note refuses nothing. The verdict is stored with the rules of the folder, and a run of that folder reuses it until a rule changes.
- **Verifiable completion.** A run can declare completion conditions: shell commands that MomongaCode runs itself, in the sandbox, when the model stops. A run ends `COMPLETED` only when every condition it owes passed on the final state of the workspace; otherwise the failures go back to the model, and a run that stops again without a change ends `STOPPED` with the reason `conditions_unmet` and names the conditions. `momonga report` shows the outcome (see section 5).
- **Auto mode.** `momonga auto-mode` measures how well a model judges approvals for auto mode. Auto mode is honored only from user settings or the command line.
- **Sandbox.** Bash runs under Seatbelt on macOS and bubblewrap on Linux. Windows has no sandbox in this release: Bash asks before every command.
- **Memory and rules.** `momonga memory` and `momonga rule` (see section 2).
- **Skills and agents.** Skills are `SKILL.md` files found in `.momonga/skills` and `.agents/skills` of the project and in `~/.momonga/skills` and `~/.agents/skills`. A general subagent, `general-purpose`, is built in; custom agents are read from `.momonga/agents` directories, and a custom agent named `general-purpose` replaces the built-in one. Project skills are loaded only for trusted folders.
- **MCP.** Servers over stdio or HTTP with OAuth. `momonga mcp list` and `momonga mcp login <server>`. Pending MCP input requests are handled with `momonga elicit`.
- **Hooks.** Commands run on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, and `SessionStart`. A hook that exits with code 2 blocks.
- **Editor integration.** `momonga acp` speaks the Agent Client Protocol on standard input and output.
- **Observability.** `momonga trace` shows the model and tool spans of a run, `momonga cost` shows what it cost, and an OTLP endpoint can be configured under `telemetry.otlp`.
- **Background jobs and runs.** `momonga status`, `momonga jobs`, `momonga attach`, and `momonga cancel`.
- **Delegated work.** A mandate hands work over with bounds, as section 5 describes: `--mandate <name>` on `momonga -p`, or `/delegate <mandate> <request>` in the interactive session.
- **Measured reliability.** `momonga reliability` reports how runs ended, `momonga eval bench <folder>` runs a fixed bench set on one model, and `momonga permissions review` samples recorded permission decisions for review (section 5).

## 5. Usage

```text
momonga [options] [prompt]
```

[docs/reference.md](docs/reference.md) lists every option and command, with the options of each command, the settings keys, the environment variables, and the exit codes. It is generated from the product's own tables. Run `momonga <command> --help` for the options of each command.

`momonga update` replaces the executable with the latest release after verifying its checksum and signature. `momonga update --check` only reports whether a newer release exists. An update never interrupts running work. If the daemon was running, both `momonga update` and the automatic update start a daemon of the new version beside it. The new one serves every new request at once. The old one accepts no new work, finishes the steps and background jobs it already runs, and then ends by itself; `momonga daemon status` lists it as retiring until then. A session opened before the update keeps working on the old daemon while that daemon lives, and is then told that momonga was updated and to reopen it. If the new daemon does not start, the new version stays installed, the old daemon keeps running, and the message says what to run. `momonga daemon stop` is the only command that interrupts running work: it stops every running daemon, and it first prints how many running steps and background jobs it interrupts.

A release build also checks for updates in the background, at most once every 24 hours. When it starts a command other than `update` and the internal ones, it runs the check in a detached process and, if a newer release exists, installs it on its own. The installation verifies the release's signed checksum list, the executable's sha256 and, where the build pins an Apple Team ID, its Developer ID signature, and it runs the new executable with `--version` before it replaces the file. If the check or the installation fails, nothing is replaced. Once the new executable is in place, a daemon of the new version is started beside a running one as described above, and a session that was already open keeps the old one until that daemon ends. Before a later command runs, `momonga` prints a one-line notice once (on standard error, or in the interactive session's notices) that the update was installed or that the check failed. Set `"autoUpdates": false` in the user settings to turn the background check and its notices off; it is read only from user settings. A build run from source never updates itself.

### Delegated work

A mandate is a named grant in your user settings, under `mandates`: the rules it adds (`allow`, `ask`, `deny`), the completion conditions it owes (`until`, `require`), and its budget (`steps`, `tokens`, `costUsd`, `timeMs`, `retries`). A run under a mandate runs only what the mandate and your rules allow; a call the mandate asks about is held for your approval while the rest of the run goes on, and `onQuiescent` says whether a run with nothing else to do waits for that approval (`wait`) or ends with a report (`report`). Start one with `momonga -p --mandate <name> "<request>"`, or `/delegate <mandate> <request>` in the interactive session. Mandates are read only from the user settings. When a run under a mandate is created, the daemon checks the rules of the folder together with the mandate's, and refuses the run if an allow rule gets around a deny rule.

Git and pull request operations (`GitPush`, `GitFetch`, the pull request and issue tools) reach a remote only through a forge you declare in `forges`: an entry with an `id`, a `descriptor`, its `hosts`, its `apiBaseUrl`, and one credential reference, `credential.env` or `credential.secret`. A remote written for SSH on a declared forge is reached through that forge's HTTPS address with its credential; a remote on no declared forge is refused, and the refusal names the entry to add. Git started for such an operation takes no hook, credential helper or proxy program from the repository.

`momonga -p --issue <address> --mandate <name>` works on one issue of a declared forge and ends with a pull request that closes it and a comment on the issue. The issue watch, `issues.watch` in the user settings, asks the declared forge of each entry every five minutes for open issues that carry its `labels` and whose author has one of its `authorAssociation` values, and starts each new one once in the entry's `folder` under its `mandate`. An entry with neither filter takes no issue, and pull requests are never taken.

A budget bounds every run. Without one, a run stops after 50 steps or 1 000 000 tokens. `--max-cost-usd <usd>` on `momonga -p`, or `limits.maxCostUsd` in the user settings, stops a run before a model request that would pass that amount; a mandate's budget bounds the runs under it.

### Verification and reports

`momonga reliability` reports, over the runs of a period, how many completed, recovered, repeated work, needed you, ran out of budget, and what they took in time and cost, grouped by model, mode, agent, origin or period; `--json` and `--out <file>` keep the report. `momonga eval bench <folder>` runs every case of the bench set in the folder on one model, each trial in a fresh copy of its repository, and checks it with the oracle of that case; `momonga eval compare <baseline> <candidate> --gate reliability` judges two such reports. `momonga permissions review` lists a sample of recorded calls that ran without asking you and of calls that asked, and stores your review of each (`--label correct`, `unneeded_ask`, or `missed_ask`).

When a run fails its conditions, it ends `STOPPED`; no stronger model takes it over.

### Verifiable completion

A run declares its completion conditions when it starts, and the set does not change while it runs. The declaration is the union of three sources:

- the request: `--until` and `--require` on `momonga -p`, or the mandate an ACP client or a benchmark task sends;
- the agent definition: `conditions` and `requirements` in the front matter of a custom agent (`inherit: false` in a request or an agent narrows the declaration to its own conditions);
- the settings: every command you set in `verification.commands`, and the check of the folder that you accepted, is a standing condition of the folder. It is owed only by a run that changed the workspace; a run that only answers a question does not pay for a test suite. The default list of `verification.commands` declares no condition.

When the model stops, Momonga Code runs every owed condition itself. A command the model ran, even the same command with exit code 0, is never evidence. If a condition fails and the run changed the workspace since the last failed round, the failures go back to the model; if the model stops again without a change, the run ends `STOPPED` with the reason `conditions_unmet`. A check runs for at most its declared timeout, or 600 seconds. With `"verification": { "required": true }`, a run that changed the workspace without any declared condition also ends `conditions_unmet`. A condition that a `deny` rule matches refuses the run when it is created.

`momonga report [run-id]`, and `/report` inside the interactive session, show the report of a run: each condition with its state and exit code, what was not run and why, the files the run changed, the residual risk as counted facts, and the commands the model ran that equal a condition (informational). The interactive session, `--print` and ACP show each check as it runs and name the unmet conditions when the run ends. The check of a folder is proposed once: when the interactive session starts in a trusted folder that declares a test command (a `test` script of `package.json`, or a `test` rule of a `Makefile` or `justfile`), it asks whether that command is the check of the folder. Your answer, accepted, typed or declined, is kept in your user settings under `projectChecks`. `/init` and `/config` show and change it, and so does `momonga project-check show`, `set <command>` and `clear`. A run that changed the workspace with no declared condition and no check ends unverified: nothing is learned from it, and a notice says how to declare a check. `verification.required` is `false` by default; with `true`, such a run ends `conditions_unmet` instead.

**Changed behaviour for folders that set `verification.commands`.** Before this release these commands only told the memory which commands count as verification. They are now also completion conditions: a run that edits files ends `STOPPED` (`conditions_unmet`) where it used to end `COMPLETED`, whenever one of the commands fails on the final state of the workspace, and each of them runs after the model stops. `momonga -p` exits non-zero for such a run. Memory follows the same verdict: a run is a verified success, and so may propose memories and repository facts, only when it declared at least one condition and all of them passed; a passing command the model ran itself no longer counts.

Inside the interactive session, slash commands include `/help`, `/clear`, `/exit`, `/mode`, `/model`, `/rule`, `/memory`, `/auto-mode`, and `/cost`, `/status`, `/jobs`, `/trace`, `/report`, `/mcp`, `/context`, `/policy`, `/gateway`, which run the command of the same name. `/help` lists the rest. The configured models are seen and changed from the last row of `/model`, `Model settings…`, or from the `Models` entry of `/config`.

## 6. Configuration

### Settings files

| File | Scope |
| --- | --- |
| `~/.momonga/settings.json` | User settings. Everything can be set here |
| `<project>/.momonga/settings.json` | Project settings, read only for trusted folders |
| `~/.momonga/projects/<hash>/settings.local.json` | Local settings for one project, kept outside the repository |
| `<project>/.mcp.json` | Project MCP servers |

Project and local settings cannot set `models`, `credentials`, `mcp`, `mcpServers`, `sandboxNetwork`, `sandbox`, `sandboxUnixSockets`, `telemetry`, `projectApprovals`, `projectChecks`, `retention`, `network`, `limits`, `ceilings`, `mandates`, `issues`, `forges`, `operations`, `pricing`, `autoUpdates`, `daemon`, `gateway`, `runtime`, or `autoMode`; those keys are discarded with a warning. Nor can they set `tools.ripgrep`, `tui.screen`, `tui.mouse`, or `tui.copyOnSelect`. They can set `permissions.defaultMode` only to modes other than `bypassPermissions` and `auto`. In `env`, only a short allowlist of names is kept. Unknown keys are ignored with a warning.

### Models

A model is called by its own name: the name its server gives it. Its full name is `server/own-name`, for example `ollama/devstral-small-2:latest`. Where one name is enough, the own name alone works (`--model devstral-small-2`); when two servers serve a model of the same name, write the full name.

Each server or account is one entry of `models.connections`, with an `adapter` (`ollama`, `chat-completions`, `open-responses`, `anthropic`, or `managed`), its address, and the list of its `models`. Each model has an `id`, which is the server's own name for it, and its `capabilities`. The server part of the full name is the connection's `provider`. When you leave `provider` out it is derived: `ollama` and `anthropic` for those adapters, the account for a subscription plan, the program for a `managed` connection, and otherwise a name made from the address, such as `srv-127.0.0.1-1234`.

Credentials are declared by reference and never written into the file:

- `apiKeyEnv` names an environment variable that holds the key.
- `apiKeySecret` names an entry in the platform secret store, which you fill with `momonga secret set <name>`.
- An `anthropic` connection needs exactly one of the two. `chat-completions` and `open-responses` connections accept at most one. `ollama` and `managed` connections take none.

Example:

```json
{
  "models": {
    "connections": [
      {
        "adapter": "ollama",
        "baseUrl": "http://127.0.0.1:11434",
        "models": [
          { "id": "your-model-name:latest", "capabilities": { "contextWindow": 32768, "maxOutputTokens": 4096 } }
        ]
      },
      {
        "adapter": "chat-completions",
        "provider": "example",
        "baseUrl": "https://api.example.com/v1",
        "apiKeyEnv": "EXAMPLE_API_KEY",
        "models": [
          { "id": "example-model", "capabilities": { "contextWindow": 128000, "maxOutputTokens": 8192 } }
        ]
      }
    ],
    "start": "example/example-model",
    "fallback": ["ollama/your-model-name:latest"],
    "billingChanges": [{ "from": "metered", "to": "local" }]
  },
  "permissions": {
    "defaultMode": "manual",
    "allow": ["Bash(npm test:*)"],
    "deny": ["Bash(rm:*)"]
  }
}
```

`models.start` is the model a new session starts with; without it, the first model in the file is used. `models.fallback` is the ordered list of models tried when the model of a request cannot answer. A request falls from a metered model to a local one, or the reverse, only when `models.billingChanges` allows that change; otherwise a warning is shown.

The values in `capabilities` are what you declare for your model; set them to the real values for the model you use. `momonga gateway probe <model>` measures a model and records the result.

A `managed` connection names a server program with `server`: the built-in `fm`, or a program you declare under `models.servers`.

Other keys under `models`: `roles` (the model for `compaction`, `reflection`, or `analysis` calls), `dialects`, `headersTimeoutMs`, and `idleTimeoutMs`. A connection can also set `billing`, `maxConcurrency`, and `admissionTimeoutMs`.

You can make every one of these changes without editing the file: `momonga models add`, `remove`, `start`, `fallback`, `billing`, `role`, and `set` in a shell, or `/model`, then `Model settings…`, in a session.

A model request can be sent twice. After a crash of the gateway or the runtime, or when a server fails before its answer starts, Momonga Code sends the same request again, and the server may run and bill it twice. A second send is recorded and marked `retry_of`: the usage record of its answer carries `retry_of_seq` and its trace span carries `momonga.retry_of`, both naming the first send. If a server accepts an idempotency key, set `idempotencyKeyHeader` on its connection to the name of the header the server reads the key from, for example `"idempotencyKeyHeader": "Idempotency-Key"`. Momonga Code then sends the same key on a request and on every resend of it, so that such a server answers and bills it once. Without the setting no key is sent. [docs/threat-model.md](docs/threat-model.md) states this risk in full.

### Permission rules

A rule is `Tool(specifier)`, or a tool name alone for every call of that tool. It can name every tool of the product, including `Agent`, `LoadTools`, `activate_skill` and the operations tools, and an MCP tool as `mcp__<server>__<tool>`; `mcp__<server>__*` names every tool of a server. A path specifier keeps parentheses as text, so `Edit(app/(auth)/**)` matches `app/(auth)/page.tsx`. A rule that cannot be read is reported by itself when the settings load, with its file, its key and the reason, and the other rules of the file still load.

In the example above, `Bash(npm test:*)` allows every command whose first words are `npm test`, with any options after them. A rule matches only when its words are the first words of the command, with nothing between them: `git -c core.pager=<program> log` does not match `Bash(git log:*)`, but it does match `Bash(git:*)`. A `*` inside a Bash rule matches any text, so `Bash(curl *)` matches every `curl` command. A command the shell parser cannot follow, such as one built at run time, is not decided by a rule: you decide it.

A `Bash(...)` allow rule matches the command text literally, as in Claude Code, and does not check what the options of the program do. So it also allows options that make the program run another program, such as `npm test --script-shell=<program>` under `Bash(npm test:*)`, `find . -exec <program> {} \;` under `Bash(find:*)`, or `git -c core.pager=<program> log` under `Bash(git:*)`. Write an allow rule only for a program whose every option you accept. An allow rule beside a narrower deny rule is correct use: with `Bash(git:*)` allowed and `Bash(git push:*)` denied, every `git` command runs except a push. `momonga policy verify` shows a rule that is redundant, shadowed by another, or cannot be reached, as a note that refuses nothing.

A command allowed this way still runs inside the sandbox. It has no network unless the call asks for it. The model sets `network` on the Bash call, either to `{"hosts": ["registry.example.org"]}` for named hosts (a name or an IP address, optionally with `:port`) or to `"open"` for unrestricted access, and you are asked to approve that call, with the request and the hosts named in the approval. Only you can grant it: a hook and the `auto` mode classifier never do. The approval holds for that one call. `Network(registry.example.org)` and `Network(*.example.org)` in the `permissions` of your user settings allow, ask about or deny those hosts without a question each time; a folder's settings cannot hold them. The `sandboxNetwork` setting refuses every request (`deny`), asks for each (`ask`, the default), or grants them without asking (`allow`); `--sandbox-network deny`, `ask` or `allow` sets it for one session and wins over the setting, and a folder's settings cannot set it. An allow rule never covers `"open"`. With named hosts the command reaches the network only through a proxy that MomongaCode runs for that command on this machine: the proxy carries HTTP and HTTPS, lets through only the granted hosts, closes a tunnel that does not open with the granted name, and refuses a name that resolves to a loopback, link-local, or private address unless that address is granted itself. A refused host is named in the tool result. A program that does not use the proxy variables (`HTTPS_PROXY` and the like), such as SSH, stays without network. A command that only reads never gets the network. File deny rules, such as `Read(...)` and `Edit(...)`, are enforced by the operating system, so no program the command starts can read or write a denied path. The command can write only where the sandbox allows writes. A `Bash(...)` deny rule, such as `Bash(rm:*)` in the example, matches only the command text, so it does not stop a program that an allowed command starts through an option.

The secret locations, such as `~/.ssh`, `~/.aws`, `~/.netrc`, the home of MomongaCode and the platform key store, stay denied to reading and writing in every mode, `bypassPermissions` included; [docs/threat-model.md](docs/threat-model.md) lists them all.

An approval shows the whole command, or every argument of an MCP call or an operation, escaped so that no character of it can redraw the screen, and the model's own description of the call labelled as the model's claim. A changed argument or description asks again. In `/config`, removing a permission rule or an additional folder asks first and names the rule or the folder and the settings file it comes from.

When a trusted folder adds or changes a hook group, its mandate file, a server of its `.mcp.json`, or one of its agents, that item is not used until you approve it: you are asked about that item, and `momonga trust` lists what waits for approval.

With `"sandbox": "none"` none of these bounds apply, so an allow rule no longer lets a command run without approval: Bash asks before every command, and in `auto` mode the classifier decides.

[docs/threat-model.md](docs/threat-model.md) states these and the other risks that MomongaCode accepts by design.

### Other settings

[docs/reference.md](docs/reference.md) lists every settings key with its values and the settings files that may set it.

Momonga Code stores its data under `~/.momonga` (settings, `state/` databases, `logs/`, `skills/`, `agents/`, and per-project data).

Instruction files named `AGENTS.md` are read into the context.

### Installer options

You set nothing. The install command in section 1 works from the first release on, once the repository is public: no release has been published yet, and the repository is private until the release, so until then there is nothing to download.

The script downloads `SHA256SUMS` and `SHA256SUMS.sig` from the latest GitHub release of `yuuichieguchi/MomongaCode`, verifies the signature with `ssh-keygen` against the release public key, checks the SHA-256 of the executable, and only then installs it. Nothing is installed if a check fails. `ssh-keygen` must be available; on Windows that means the OpenSSH Client optional feature.

Both installers read a few optional environment variables, such as `MOMONGA_VERSION` to install one version and `MOMONGA_MODIFY_PATH=0` to leave your PATH alone; [docs/reference.md](docs/reference.md) lists them all.

The installers change your PATH only when the install directory is missing from it (`install.sh` checks the PATH of the running shell, `install.ps1` the user PATH):

- `install.sh` adds one marked block to a shell startup file: `.zshrc` (under `ZDOTDIR` if set) for zsh, the first existing of `.bashrc`, `.bash_profile`, `.profile` (else `.bashrc`) for bash, `~/.config/fish/config.fish` (with `fish_add_path`) for fish, and `~/.profile` for any other shell. Running the installer again updates that block in place and prints a message about it. When the install directory is already on the PATH of the running shell, it changes nothing and prints nothing about PATH.
- `install.ps1` appends the install directory to the user PATH.
- With `MOMONGA_MODIFY_PATH=0`, neither script changes anything and both print the command to run in the current shell instead.

## 7. Architecture

Momonga Code is an npm workspace of packages under `packages/`. The `momonga` command is a client; the work is done by background processes.

- **Client.** `packages/cli` (command line, terminal UI, ACP server). It starts and talks to the daemon.
- **Supervisor.** `packages/supervisor` runs the daemon: it starts, restarts, and stops two child processes, the gateway and the runtime. Each start of the daemon is a generation with its own supervisor; a newer generation takes over new work while an older one finishes what it runs and ends by itself. A settings change applies in place: each child reads the settings per operation, and no child is restarted for it.
- **Runtime.** `packages/runtime` runs sessions, runs, and the model and tool loop. It builds each request with `packages/context`, applies `packages/policy` to tool calls, executes tools from `packages/tools` inside `packages/sandbox`, and records everything in `packages/store`.
- **Gateway.** `packages/gateway` is the one place that talks to models. It has adapters for chat-completions, Open Responses, Anthropic, and Ollama, plus routing, retry, admission, and probing. Apple's `fm` is a managed server: a server program that Momonga Code starts itself and reaches through the chat-completions adapter.
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

Contributions are welcome through pull requests on GitHub. [CONTRIBUTING.md](CONTRIBUTING.md) says how to build from source and run the tests, and [SECURITY.md](SECURITY.md) says how to report a vulnerability.

## 10. License

Momonga Code is open source under the MIT License. See the [`LICENSE`](LICENSE) file.

Bundles ripgrep (MIT or Unlicense); see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## 11. Disclaimer

Momonga Code is provided as is, without warranty of any kind. It runs commands and edits files on your machine, and it sends the content of your prompts, files, and tool output to the model servers you configure. You are responsible for the models, targets, permission rules, sandbox setting, and permission mode you choose, for the cost of any hosted model you use, and for reviewing what the agent does. A model can make mistakes. Do not use `bypassPermissions` mode or `"sandbox": "none"` on a machine or in a folder where an unwanted command could cause harm you cannot undo.
