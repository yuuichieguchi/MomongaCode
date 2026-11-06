# Vendored JSON-Schema-Test-Suite

- Source: https://github.com/json-schema-org/JSON-Schema-Test-Suite
- Commit: 245a45abc90190c0bff04d97e6d2b541b4bb9f12 (also in `COMMIT`)
- Licence: MIT (`LICENSE`)
- `tests/draft2020-12/` including `optional/`, `tests/draft7/` (required tests only) and `remotes/`, unchanged.
- `metaschemas/draft2020-12/`: the official draft 2020-12 meta-schemas, fetched from https://json-schema.org/draft/2020-12/schema and https://json-schema.org/draft/2020-12/meta/<vocabulary>. The suite's `remotes/draft2020-12/format-assertion-*.json` and `metaschema-*.json` refer to the vocabulary documents.
- Used by `packages/foundation/test/json-schema-test-suite.test.ts`.
