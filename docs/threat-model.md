# Threat model

This document states risks that Momonga Code accepts by design, and what still bounds each of them.

## Bash allow rules match the command text literally

A `Bash(...)` rule in `permissions.allow` matches the words of the command literally, in the same way as Claude Code. Momonga Code does not inspect what the options of the allowed program do. A prefix rule therefore allows every option of that program, including options that make it run another program:

- `Bash(git log:*)` allows `git -c core.pager=<program> log`, which runs `<program>` as the pager.
- `Bash(find:*)` allows `find . -exec <program> {} ;`.
- `Bash(npm run test:*)` allows `npm run test --script-shell=<program>`.

Words that are not next to the program name still ask: `git -C /tmp log` does not match `Bash(git log:*)`. Commands with no matching user rule are judged by the built-in read-only set, which does not approve such options automatically.

Write an allow rule only for a program whose every option you accept. What still bounds a command allowed this way:

- The operating-system sandbox (Seatbelt on macOS, bubblewrap on Linux) runs the command, including any program it starts.
- Network access is denied inside the sandbox.
- Deny rules are enforced by the operating system, so a program started through an option cannot read or write a denied path either.
- The command can write only where the sandbox allows writes, such as the workspace.

With `"sandbox": "none"` none of these bounds apply.

## MCP credential redaction

Every credential value configured for an MCP server is replaced with `[redacted]` in tool output, error messages, and diagnostics before the model sees them. This covers HTTP header values, OAuth secrets, and the `env` values of a stdio server.

Redaction has limits:

- **Guessable values.** Redaction hides a value; it does not keep a model from guessing it. A model steered by injected content can send candidate strings to a tool that echoes its input and see which one comes back as `[redacted]`. A value found in a common-password list (the check NIST SP 800-63B section 5.1.1.2 asks for, against a pinned list) can be found this way in few tries. Momonga Code accepts such a value, because you cannot always change the password of the service you use, and shows the notice "This credential could be guessed" naming the server and the header or variable, never the value.
- **Short values.** A value under 8 characters is too short to hide reliably: it is easy to guess and easy to find in ordinary text. Momonga Code accepts it and shows a notice that it is too short to be hidden from tool output.
- **Transformed values.** Only the exact configured text is replaced. A server that returns the value encoded, split, or changed in case is not redacted.

Neither notice refuses or blocks the server. Use a long, random credential for any MCP server whose tools can return text you or the server do not control.
