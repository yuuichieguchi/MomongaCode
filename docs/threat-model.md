# Threat model

This document states risks that Momonga Code accepts by design, and what still bounds each of them.

## Bash allow rules match the command text literally

A `Bash(...)` rule in `permissions.allow` matches the words of the command literally, in the same way as Claude Code. Momonga Code does not inspect what the options of the allowed program do. A prefix rule therefore allows every option of that program, including options that make it run another program:

- `Bash(git:*)` allows `git -c core.pager=<program> log`, which runs `<program>` as the pager.
- `Bash(find:*)` allows `find . -exec <program> {} ;`.
- `Bash(npm run test:*)` allows `npm run test --script-shell=<program>`.

A rule matches only when its words are the first words of the command, with nothing between them, so an option placed between those words still asks: `git -c core.pager=<program> log` and `git -C /tmp log` do not match `Bash(git log:*)`. Commands with no matching user rule are judged by the built-in read-only set, which does not approve such options automatically.

Write an allow rule only for a program whose every option you accept. What still bounds a command allowed this way:

- The operating-system sandbox (Seatbelt on macOS, bubblewrap on Linux) runs the command, including any program it starts.
- Network access is denied inside the sandbox.
- Deny rules are enforced by the operating system, so a program started through an option cannot read or write a denied path either.
- The command can write only where the sandbox allows writes, such as the workspace.

With `"sandbox": "none"` none of these bounds apply.

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

- **Guessable values.** Redaction hides a value; it does not keep a model from guessing it. A model steered by injected content can send candidate strings to a tool that echoes its input and see which one comes back as `[redacted]`. A value found in a common-password list (the check NIST SP 800-63B section 5.1.1.2 asks for, against a pinned list) can be found this way in few tries. Momonga Code accepts such a value, because you cannot always change the password of the service you use, and shows a notice that the credential could be guessed, naming the server and the header or variable, never the value.
- **Short values.** A credential value under 8 characters is not redacted, because it is too short to hide: the same few characters turn up in ordinary text. Momonga Code accepts it and shows a notice that it is too short to hide and is not redacted from tool output, naming the server and the header or variable. A header whose name contains none of the words above and whose value is under 8 characters is not a credential, so it is neither redacted nor reported.
- **Which part is judged.** For a header whose name contains one of the words above, both notices judge the last word of the value, such as the token after `Bearer`, not the whole value.
- **Transformed values.** Only the exact configured text is replaced. A server that returns the value encoded, split, or changed in case is not redacted.

Neither notice refuses or blocks the server. Use a long, random credential for any MCP server whose tools can return text you or the server do not control.
