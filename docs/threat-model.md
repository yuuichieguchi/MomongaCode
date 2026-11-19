# Threat model

This document states the places where authority, a secret or untrusted text crosses a boundary of MomongaCode, the risks it accepts by design, and what still bounds each of them.

## Bash allow rules match the command text literally

A `Bash(...)` rule in `permissions.allow` matches the words of the command literally, in the same way as Claude Code. MomongaCode does not inspect what the options of the allowed program do. A prefix rule therefore allows every option of that program, including options that make it run another program:

- `Bash(git:*)` allows `git -c core.pager=<program> log`, which runs `<program>` as the pager.
- `Bash(find:*)` allows `find . -exec <program> {} \;`.
- `Bash(npm test:*)` allows `npm test --script-shell=<program>`.

A rule matches only when its words are the first words of the command, with nothing between them, so an option placed between those words still asks: `git -c core.pager=<program> log` and `git -C /tmp log` do not match `Bash(git log:*)`. Commands with no matching user rule are judged by the built-in read-only set, which does not approve such options automatically.

Write an allow rule only for a program whose every option you accept. What still bounds a command allowed this way:

- The operating-system sandbox (Seatbelt on macOS, bubblewrap on Linux) runs the command, including any program it starts.
- The command reaches the network only as the section [Network access of commands](#network-access-of-commands) states.
- File deny rules, such as `Read(...)` and `Edit(...)`, are enforced by the operating system, so a program started through an option cannot read or write a denied path either.
- The command can write only where the sandbox allows writes, such as the workspace.

A `Bash(...)` deny rule matches only the command text, in the same literal way. It does not stop a program that an allowed command starts through an option.

With `"sandbox": "none"` the workspace and the network are not restricted, so an allow rule no longer lets a command run without approval: Bash asks before every command, and in `auto` mode the classifier decides. The product's own home stays denied to the command where a platform sandbox exists, as the section [Processes the product starts](#processes-the-product-starts) states.

## Settings this document quotes

The default of `sandboxNetwork` is `ask`. The default of `sandbox` is `seatbelt` on macOS, `bubblewrap` on Linux and `none` on Windows. On macOS and Linux the launcher of that sandbox must be executable (`/usr/bin/sandbox-exec`, `/usr/bin/bwrap`); when it is not, a sandboxed run refuses to start and names the launchers it looked for, and the default never falls to `none`.

## Network access of commands

A command states the network it needs: none, named hosts, or `open`, which is unrestricted. The decision for that network is taken in this order:

1. A deny rule for the network that covers the request denies the command.
2. With `sandboxNetwork: deny` every request for network is denied.
3. An ask rule for the network that covers the request asks the person, except in `bypassPermissions`.
4. With `sandboxNetwork: allow`, in `bypassPermissions`, or when allow rules cover every named host, the network is given.
5. Otherwise the person is asked for that call. An allow rule never covers `open`.

What still bounds a given network:

- **Named hosts go through a proxy of that command.** The sandbox lets the command reach only the proxy the product starts for it, and the proxy forwards only to the granted hosts.
- **A tunnel is bound to its granted name.** The proxy closes a `CONNECT` tunnel whose connection does not open with a TLS server name or an HTTP `Host` equal to the granted host.
- **`open` is unrestricted.** A command given `open` can reach any host.
- **Unix sockets.** Under Seatbelt and bubblewrap a command can connect only to the Unix sockets listed in `sandboxUnixSockets.allow`; with none listed, it can connect to none. An entry inside a folder the product owns is discarded with a warning when the settings load, because those sockets are always denied. On Linux this was proved in a container run (the `bubblewrap-sockets` and `relay-hosts-real` tests). With `"sandbox": "none"` Unix sockets are not limited.

## Secret locations

Reading and writing these places is denied in every permission mode, including `bypassPermissions`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.azure`, `~/.kube`, `~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, the product's home folder, and the platform key store.

## Processes the product starts

Every process the product starts is denied the product's own home by the platform sandbox: tool commands under every `sandbox` setting including `none`, stdio MCP servers, hooks, `!` commands, and the model servers the product manages. The denied places are the home folder, the key store, the product's programs and its temporary folder; the scratch folder of the command itself is given back. `"sandbox": "none"` means that the workspace and the network are not restricted; it never gives a process the product's sockets, credentials or stores.

This holds where a platform sandbox exists: Seatbelt on macOS, bubblewrap on Linux. On Linux without bubblewrap installed, and on Windows, which has no such sandbox yet, a process started with `"sandbox": "none"` can read and change the product's home.

When a command is stopped and the product cannot confirm that every process of it ended, the result says so and the command's marker is kept.

## The person's capability

The routes that act for the person require a capability: a random 128-bit value kept in the owner-only file `person-capability` in the product's home and sent in the header `momonga-person-capability`. The value is compared in constant time, and a request without the value is refused with `person_only`. Nothing the product starts inherits the value, and the processes it starts are denied the home where the file lives. Lineage checks of the asking process are not used.

The routes that require it:

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

The capability bounds the processes the product starts, not the account. Any other process that runs as the same account can read the capability file and reach the product's sockets, and so can create sessions, answer approvals, change trust, rules and memories, and read every session, as the person can. This includes a program started by a tool command that ran with `"sandbox": "none"` where no platform sandbox exists. Keep the account free of programs you do not trust.

## The credential route of the supervisor

The supervisor serves `GET /v1/credentials/<NAME>` on its control socket. It hands the gateway the value of a model credential variable from the supervisor's own environment. Each time it starts the gateway it draws a random 256-bit capability for that start and gives it in `MOMONGA_CREDENTIAL_CAPABILITY`; the gateway sends it in the header `momonga-credential-capability`. The supervisor answers only a request with the capability of the gateway it runs now, and only for a name the settings declare as a model credential; anything else is refused. The gateway adds every value it is handed to its redaction. A process of the same account that reaches the socket cannot use the route without the capability.

## The secret-store program is found on PATH

The program of the platform secret store (`security` on macOS, `secret-tool` on Linux) is found on `PATH`. The supervisor resolves it once when it starts, to an absolute path, and refuses a program that is not owned by you or by root or that lies in a folder another account can change. The resolved path is written to the daemon log in the event `secret_store.chosen` and handed to the processes the supervisor starts in `MOMONGA_SECRET_PROGRAM`. Trust in the folders on `PATH` is the trust in that program: a program of your own placed earlier on `PATH` is used.

## Windows pipe names

On Windows the product's named pipes are `\\.\pipe\momonga-<token>-<name>`. The token is a random 128-bit value kept in the owner-only file `run/endpoint-token` of the product's home; a pipe name without it is neither served nor dialled. This makes the names hard to guess for another account; it is not an access check of the connecting process.

## Untrusted text reaches the model

Tool output (including the file contents a tool reads), attached files and the output of `!` commands are enclosed by one function, `fenceUntrusted`, in the tags `tool_output`, `attached_file` and `user_shell_command`. The fence carries a random boundary of the session; when the text itself contains that boundary, a longer one is derived from the text. The model is told that fenced text is data. It may still follow instructions written in such text: what bounds the result is the permission system and the sandbox.

## Auto mode

In `auto` mode a classifier model decides whether a tool call runs without asking. The proposed call it judges is written by the model whose call it is, and the request it compares the call against can contain injected text. The classifier is told to treat both as data, but a model can be misled: deny rules, secret locations and the sandbox bound what an approved call can do.

## Git and forge credentials

A git operation that reaches a remote over HTTPS gets the forge credential only for a remote whose origin is the forge's HTTPS address, through the product's own askpass helper. A git process that would serve a remote reached both over HTTP or HTTPS and otherwise is refused. The repository's `pre-push` hook runs with no credential and no network.

## Outbound proxy credentials

A user name and password in the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY` and their lower-case forms) are sent to the proxy and are added to the redaction.

## MCP credential redaction

Credential values of 8 characters or more configured for an MCP server are replaced with `[redacted]` in tool output, error messages, and diagnostics before the model sees them. The values that count as credentials are:

- **HTTP headers** of a remote server: every header except descriptive ones such as `Accept`, `Content-Type` and `User-Agent`, when its name contains `auth`, `token`, `key`, `secret`, `cookie` or `password` (in any case), or when its value has 8 characters or more. For a header whose name contains one of those words, each word of the value that has 8 characters or more, such as the token after `Bearer`, is redacted too.
- **OAuth secrets** that the server's sign-in returns.
- **`env` values** of a stdio server, but only those the credential rules classify as credentials. Other `env` values are passed to the server and are not redacted. A variable is a credential when:
  - it is named in `credentials.env` (by name or by a `*` pattern), or by the `apiKeyEnv` of a model target whose adapter is not `fm` or `ollama`; `credentials.keep` does not override this;
  - it is not listed in `credentials.keep`, and its name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `CREDENTIAL` or `CREDS`, has a `_`-separated word `AUTH`, `COOKIE`, `SESSION`, `PRIVATE` or `PASS`, or ends in `_PWD` (in any case);
  - it is not listed in `credentials.keep`, and its value is a URL with a password or matches one of `credentials.valuePatterns`;
  - it holds the same value as a variable that is a credential by one of the rules above, even when it is listed in `credentials.keep`.

Redaction has limits:

- **Guessable values.** Redaction hides a value; it does not keep a model from guessing it. A model steered by injected content can send candidate strings to a tool that echoes its input and see which one comes back as `[redacted]`. A value found in a common-password list (the check NIST SP 800-63B section 5.1.1.2 asks for, against a pinned list) can be found this way in few tries. MomongaCode accepts such a value, because you cannot always change the password of the service you use, and shows a notice that the credential could be guessed, naming the server and the header or variable, never the value.
- **Short values.** A credential value under 8 characters is not redacted, because it is too short to hide: the same few characters turn up in ordinary text. MomongaCode accepts it and shows a notice that it is too short to hide and is not redacted from tool output, naming the server and the header or variable. A header whose name contains none of the words above and whose value is under 8 characters is not a credential, so it is neither redacted nor reported.
- **Which part is judged.** For a header whose name contains one of the words above, both notices judge the last word of the value, such as the token after `Bearer`, not the whole value.
- **Transformed values.** Only the exact configured text is replaced. A server that returns the value encoded, split, or changed in case is not redacted.

Neither notice refuses or blocks the server. Use a long, random credential for any MCP server whose tools can return text you or the server do not control.

## A model request can be sent twice

A model request can be sent twice to its server. MomongaCode sends a request again when it cannot know that the first send was answered:

- After a crash of the gateway or the runtime while a request was in flight, the restarted process sends the request of the interrupted step again.
- When a server fails, or the connection to it breaks, before its answer starts, the gateway sends the request again.

The server may have received the first send and worked on it. A server that does not recognise the second send as the same request runs the model twice and can bill both. MomongaCode uses one answer.

What bounds this:

- **An answered request is not sent again.** The gateway keeps a finished answer under the key of its request for 7 days and replays it to a caller that asks again with that key.
- **Every send is recorded.** A second send of the same request is marked `retry_of`: its trace span carries `momonga.retry_of`, the number of the first send, so a doubled request is visible in the trace.
- **A server that accepts an idempotency key can be told the key.** Set `idempotencyKeyHeader` on the server's entry of `models.connections` to the name of the header the server reads the key from, for example `"idempotencyKeyHeader": "Idempotency-Key"`. MomongaCode then sends a key in that header: the same key on the first send and on every resend of that request to that server, and a different key for every other request and for every other server. A server that honours the header does not run or bill the model again for the second send.

`idempotencyKeyHeader` is a fact you declare. MomongaCode cannot measure whether a server honours such a header, and never infers it from the name of a server or a model. Without the setting no key is sent, and the double send remains: a request can be billed twice after a crash. Accept that for the server, or use a server that offers such a header.
