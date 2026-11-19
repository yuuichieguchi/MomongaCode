# Contributing to MomongaCode

Contributions are welcome through pull requests on GitHub.

## Building from source

```sh
npm ci
npm run bundle
node packages/cli/dist/main.js --help
```

Building a release executable is done with `npm run sea` (see `scripts/sea.ts`).

## Tests

```sh
npm ci
npm run test:setup
npm run typecheck
npm test
npm run test:e2e
npm run test:packaging
```

- `npm run test:setup` provides everything the test suites fetch: the Open Responses suite and its bun (`compliance/open-responses`), the pinned TLA+ jar, and the pinned node and ripgrep archives the packaging tests build from. A run that misses one of them, or a system program it needs (bubblewrap, openssl, zig), refuses at its start and names it with the command that provides it.
- `npm test` runs the unit suite, including the TLA+ models and the Z3 proofs. TLC needs Java 8 or later. The Z3 proofs run through the `z3-solver` dependency of `packages/verify`.
- `npm run test:tlc-deep` runs the deep tier of the TLA+ configurations, which takes much longer.
- On Windows, CI runs the unit suite without the TLC tier, which needs bash, `ps`, and `/usr/bin`.
- On Linux, tests that use the sandbox need bubblewrap installed.
- Add or update tests with every change. Behaviour that is described by a TLA+ model in `specs/tla/` is changed in the model and in the code together.

## Security

Report a vulnerability as [SECURITY.md](SECURITY.md) states, not in a public issue or pull request.
