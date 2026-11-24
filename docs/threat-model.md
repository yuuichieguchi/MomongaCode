# Threat model

This document explains where authority, credentials, or untrusted text cross a security boundary in MomongaCode, which risks are accepted by design, and what safeguards still bound each one.

## Bash allow rules match the command text literally

Like Claude Code, a `Bash(...)` rule in `permissions.allow` matches command words literally without inspecting what a program's flags do. A prefix allow rule therefore permits every option of that program—including options that execute another program:

- `Bash(git:*)` allows `git -c core.pager=<program> log`, running `<program>` as the pager.
- `Bash(find:*)` allows `find . -exec <program> {} \;`.
- `Bash(npm test:*)` allows `npm test --script-shell=<program>`.

Rules match only when their words appear consecutively at the start of the command. Placing an option between them still prompts for approval: `git -c core.pager=<program> log` and `git -C /tmp log` do not match `Bash(git log:*)`. Commands without a matching user rule fall back to the built-in read-only allowlist, which never auto-approves options like these.

Only write a `Bash(...)` allow rule for programs whose full flag set you trust. Even when a command is allowed this way, several boundaries still apply:

- **OS sandbox.** The command—and any child process it spawns—runs inside Seatbelt (macOS) or bubblewrap (Linux).
- **Network controls.** Network access follows the rules in [Network access of commands](#network-access-of-commands).
- **OS-enforced file denies.** File deny rules such as `Read(...)` and `Edit(...)` are enforced by the OS, so child processes cannot read or modify denied paths either.
- **Write scope.** Writes are limited to paths permitted by the sandbox, such as the workspace.

A `Bash(...)` deny rule also matches command text literally, so it cannot stop an allowed command from launching another program via a flag.

With `"sandbox": "none"`, workspace and network restrictions are off, so `Bash(...)` allow rules no longer skip approval: `Bash` asks before every command (or defers to the classifier in `auto` mode). On platforms with an OS sandbox, MomongaCode's own home directory still remains off-limits (see [Processes the product starts](#processes-the-product-starts)).

## Settings this document quotes

- The default of `sandboxNetwork` is `ask`.
- The default of `sandbox` is `seatbelt` on macOS, `bubblewrap` on Linux, and `none` on Windows.
- On macOS and Linux, the sandbox launcher (`/usr/bin/sandbox-exec` or `/usr/bin/bwrap`) must be executable; when it is not, a sandboxed run refuses to start and names the launchers it looked for, and the default never falls to `none`.

## Network access of commands

Each command declares the network access it needs: none, named hosts, or unrestricted (`open`). MomongaCode evaluates the request in this order:

1. A matching network deny rule blocks the command.
2. `sandboxNetwork: deny` blocks all network requests.
3. A matching network ask rule prompts you (except in `bypassPermissions`).
4. Access is granted if `sandboxNetwork: allow` is set, `bypassPermissions` is active, or allow rules cover every named host.
5. Otherwise, MomongaCode asks for your approval for that call. An allow rule never covers `open`.

**Safeguards when network access is granted:**

- **Per-command proxy for named hosts.** The sandbox lets the command talk only to a local proxy MomongaCode spawns for that command, and the proxy forwards only to approved hosts.
- **SNI / Host verification.** The proxy closes any `CONNECT` tunnel whose TLS server name or HTTP `Host` header does not match the granted host for that tunnel.
- **Unrestricted `open` access.** A command explicitly granted `open` can reach any host.
- **Unix sockets.** Under Seatbelt and bubblewrap, commands can connect only to Unix sockets listed in `sandboxUnixSockets.allow` (none by default). Any entry inside a MomongaCode-owned directory is discarded with a warning at load time, since those sockets are always denied. On Linux this is verified inside a container (`bubblewrap-sockets` and `relay-hosts-real` tests). With `"sandbox": "none"`, Unix sockets are unrestricted.

## Secret locations

Reading and writing these locations is denied in every permission mode, including `bypassPermissions`:

- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.azure`, `~/.kube`
- `~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`
- `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`
- MomongaCode's home folder and the platform key store

## Processes the product starts

Where a platform sandbox exists (Seatbelt on macOS, bubblewrap on Linux), **every** child process MomongaCode spawns is blocked from accessing MomongaCode's own home directory—including tool commands under any `sandbox` setting (even `none`), stdio MCP servers, hooks, `!` commands, and managed model servers.

- **Blocked paths:** MomongaCode's home folder, key store, executables, and temporary folder (each command keeps access only to its own scratch folder).
- **What `"sandbox": "none"` means:** It disables workspace and network isolation; it never grants access to MomongaCode's sockets, credentials, or state stores.
- **Platform gaps:** On Linux hosts without bubblewrap installed, and on Windows (which lacks a platform sandbox in this release), a process started with `"sandbox": "none"` can read and modify MomongaCode's home directory.
- **Uncertain termination:** If a command is stopped and MomongaCode cannot confirm that every descendant process exited, the tool result reports this and keeps the command's marker active.

## The person's capability

Daemon endpoints that perform user-authorized actions require a 128-bit random capability stored in the owner-only file `person-capability` inside MomongaCode's home directory and sent in the `momonga-person-capability` header.

- The capability is verified in constant time; requests missing it fail with `person_only`.
- Child processes never inherit the value and are sandboxed away from the home directory where the file lives. Process lineage checks are not relied on.

**Routes requiring this capability:**

- `POST /v1/sessions`, `PATCH /v1/sessions/:id`
- `POST /v1/approvals/:id`
- `POST /v1/sessions/:id/user-shell`, `DELETE /v1/sessions/:id/user-shell`
- `POST /v1/mcp/servers/:name/authorization`, `DELETE /v1/mcp/servers/:name/authorization`
- `POST /v1/sessions/:id/mcp/servers/:name/authorization`, `DELETE /v1/sessions/:id/mcp/servers/:name/authorization`
- `POST /v1/elicitations/:id`
- `POST /v1/markers/:name/ignore`
- `POST /v1/guidelines`, `POST /v1/guidelines/:version/rollback`
- `POST /v1/memories`, `DELETE /v1/memories/:id`, `POST /v1/memories/:id/accept`, `POST /v1/memories/:id/reject`, `POST /v1/memories/:id/restore`, `POST /v1/memories/:id/promote`
- `POST /v1/rules`, `POST /v1/rules/:id/retire`, `POST /v1/policy/verify`
- `PUT /v1/trust`, `DELETE /v1/trust`

## Other processes of the same account

The capability isolates processes **started by MomongaCode**, not arbitrary software running under your OS user account. Any other process running as your user can read `person-capability`, connect to MomongaCode's sockets, and perform any user action (creating sessions, approving calls, modifying trust, rules, or memories, and reading sessions). The same applies to commands run with `"sandbox": "none"` on platforms without an OS sandbox. Keep untrusted software out of your user account.

## The credential route of the supervisor

The supervisor exposes `GET /v1/credentials/<NAME>` on its control socket so the gateway can fetch model API keys from the supervisor's environment without passing them broadly.

- On every gateway launch, the supervisor generates a fresh 256-bit random capability and passes it in `MOMONGA_CREDENTIAL_CAPABILITY`.
- The gateway sends it in the `momonga-credential-capability` header.
- The supervisor answers only requests carrying the active gateway's capability and naming a variable declared as a model credential in settings; everything else is refused.
- Every returned secret is automatically registered for redaction in the gateway. Another process under your account cannot call this route without the capability.

## The secret-store program is found on PATH

MomongaCode looks up the OS secret-store CLI (`security` on macOS, `secret-tool` on Linux) on `PATH`.

- At startup, the supervisor resolves it once to an absolute path and rejects any binary not owned by you or `root`, or located in a directory writable by another account.
- The chosen path is logged in the daemon log as `secret_store.chosen` and passed to child processes via `MOMONGA_SECRET_PROGRAM`.
- Because lookup uses `PATH`, you are implicitly trusting directories on your `PATH`: a binary you place earlier on `PATH` will be selected.

## Windows pipe names

On Windows, MomongaCode serves named pipes at `\\.\pipe\momonga-<token>-<name>`, where `<token>` is a 128-bit random value stored in the owner-only file `run/endpoint-token` under MomongaCode's home directory. Pipe names without the token are neither served nor dialed. This makes pipe names infeasible for other local accounts to guess, though it is not an OS access-control check on the connecting client.

## Untrusted text reaches the model

Tool outputs (including file contents), attached files, and `!` command outputs are wrapped by a single helper, `fenceUntrusted`, using the tags `tool_output`, `attached_file`, and `user_shell_command`.

- Each fence uses a random per-session boundary; if the untrusted content happens to contain that boundary, a longer boundary is derived from the text.
- The model is instructed to treat fenced blocks strictly as data, but prompt injection can still influence model behavior—real enforcement comes from the permission system and the OS sandbox.

## Auto mode

In `auto` mode, a classifier model decides whether to approve a tool call without prompting you. Because the proposed call comes from the working model and the user request may contain injected text, the classifier is instructed to treat both as data—but classifiers can still be misled. By default, the session's model judges every call of a run, including the calls its subagents propose; that model may be the one that proposed the call, and it can be misled the same way. Set a separate classifier model with `/auto-mode` or `autoMode.classifier` in the user settings. Deny rules, protected secret paths, and the OS sandbox remain your hard boundaries.

## Git and forge credentials

- HTTPS Git operations receive a forge credential (via MomongaCode's own askpass helper) only when the remote's origin matches the declared forge's HTTPS address.
- Any Git invocation attempting to reach a remote over both HTTP/HTTPS and another protocol is refused.
- Repository `pre-push` hooks execute with no credentials and no network access.

## Outbound proxy credentials

Usernames and passwords embedded in proxy environment variables (`HTTPS_PROXY`, `HTTP_PROXY`, and their lowercase forms) are sent to the configured proxy and automatically added to output redaction.

## MCP credential redaction

Configured MCP credentials of 8 or more characters are replaced with `[redacted]` in tool outputs, error messages, and diagnostics before the model sees them.

**What counts as a credential:**

- **Remote HTTP headers:** Any non-descriptive header (excluding headers like `Accept`, `Content-Type`, and `User-Agent`) whose name contains `auth`, `token`, `key`, `secret`, `cookie`, or `password` (case-insensitive), or whose value is 8+ characters. For headers matching those name keywords, individual 8+ character words inside the value (such as the token after `Bearer`) are redacted as well.
- **OAuth secrets** returned during an MCP server sign-in flow.
- **Stdio `env` variables** classified as credentials (non-credential `env` variables are passed through without redaction). A variable is treated as a credential when any of the following holds:
  - It is listed in `credentials.env` (exact name or `*` pattern) or referenced by `apiKeyEnv` on a model connection whose adapter is neither `fm` nor `ollama` (`credentials.keep` cannot override this).
  - It is not in `credentials.keep`, and its name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `CREDENTIAL`, or `CREDS`, contains a `_`-delimited word `AUTH`, `COOKIE`, `SESSION`, `PRIVATE`, or `PASS`, or ends with `_PWD` (case-insensitive).
  - It is not in `credentials.keep`, and its value is a URL containing a password or matches `credentials.valuePatterns`.
  - It shares the exact value of another variable already classified as a credential, even if listed in `credentials.keep`.

**Known limits of redaction:**

- **Guessable values.** Redaction hides a secret from output, but an injected model can probe a tool that echoes input to test candidate strings until `[redacted]` comes back. Passwords appearing on a pinned common-password list (per NIST SP 800-63B section 5.1.1.2) could be discovered quickly. MomongaCode still accepts them (since you may not control the service's password) and prints a notice naming the server and header/variable—never the value.
- **Short values.** Values shorter than 8 characters are not redacted because short substrings appear naturally in normal text. MomongaCode accepts them and prints a notice naming the server and header/variable. (Headers whose names do not match the credential keywords and whose values are under 8 characters are neither redacted nor flagged.)
- **Inspected token.** For headers matching the credential keywords, both notices inspect the last word of the value (e.g., the token after `Bearer`), not the full header string.
- **Transformed values.** Only exact configured strings are replaced. Encoded, split, or case-altered copies returned by a server will not be redacted.

Neither notice blocks the server from starting. Use long, random credentials for any MCP server whose tools can return untrusted text.

## A model request can be sent twice

A model request can be sent twice to its server whenever MomongaCode cannot tell whether the first attempt succeeded:

- **After a crash:** If the gateway or runtime crashes while a request is in flight, the restarted process sends the interrupted step's request again.
- **Transport or server failure:** If the server errors out or drops the connection before streaming begins, the gateway retries the request.

If the server already processed the first request and cannot recognize the retry as a duplicate, it may run the model twice and bill both calls. MomongaCode uses only one response.

**What bounds this:**

- **Completed answers are replayed, not re-sent.** The gateway caches finished answers by request key for 7 days and replays them if asked again with the same key.
- **Every resend is traceable.** Resent requests are marked `retry_of`, and their trace span records `momonga.retry_of` with the first send's sequence number so duplicate sends are visible in traces.
- **Idempotency key support.** If a server supports idempotency keys, set `idempotencyKeyHeader` on its entry in `models.connections` (for example, `"idempotencyKeyHeader": "Idempotency-Key"`). MomongaCode then sends a unique key per request and server, reusing that exact key across all resends so an idempotency-aware server runs and bills the request only once.

`idempotencyKeyHeader` is strictly user-declared: MomongaCode cannot probe whether a server honors it and never guesses from server or model names. Without it, no key is sent and a crash can still cause a request to be billed twice—accept that behavior or use a server that supports idempotency keys.
