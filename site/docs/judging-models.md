# Judging models

Choice-only judging models use the `system-one` adapter—such as TypeSafe Jev on OpenRouter—to answer fixed-choice questions (`auto` mode approvals and memory auto review) without generating prose. Because judging models do not write responses or call tools, MomongaCode restricts them to `autoMode.classifier` and `memory.autoReviewModel`; they cannot be set as `models.start`, `models.fallback`, `--model`, or `models.roles` (`compaction`, `reflection`, `analysis`, `subagent`).

## Where judging models are used

- **`autoMode.classifier`.** Judges tool calls that no explicit permission rule matches when the permission mode is `auto`. If the judging model refuses or fails to answer, MomongaCode falls back to asking you for approval.
- **`memory.autoReviewModel`.** Reviews proposed memories one at a time when `memory.autoReview` is `true` in a trusted folder. It keeps a memory only when it judges it safe with high confidence; any other answer, refusal, or failure leaves the memory waiting for you and never rejects it.

A `system-one` connection requires `baseUrl` and `capabilities.contextWindow` for each model entry. It does not accept `maxOutputTokens` or `capabilities.toolCalling`, and MomongaCode skips discovery `GET` checks (`momonga models check`) and capability probing (`momonga gateway probe`) on `system-one` servers.

## Setting up TypeSafe Jev on OpenRouter

### 1. Store your API key

API keys are always referenced, never stored directly in `settings.json`. To store your OpenRouter key in the OS secret store under a name of your choice:

```sh
momonga secret set openrouter-api-key
```

Alternatively, pass an environment variable name with `apiKeyEnv` instead of `apiKeySecret` (the variable must be present in the environment when the daemon starts).

### 2. Configure `~/.momonga/settings.json`

Add a `system-one` entry to `models.connections` alongside your main coding model, and point `autoMode.classifier` and `memory.autoReviewModel` at its full `provider/model-id` name:

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
        "adapter": "system-one",
        "provider": "openrouter-system-one",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKeySecret": "openrouter-api-key",
        "models": [
          { "id": "typesafe/jev-1.14", "capabilities": { "contextWindow": 128000 } }
        ]
      }
    ]
  },
  "autoMode": {
    "classifier": "openrouter-system-one/typesafe/jev-1.14"
  },
  "memory": {
    "autoReview": true,
    "autoReviewModel": "openrouter-system-one/typesafe/jev-1.14"
  },
  "pricing": [
    {
      "provider": "openrouter-system-one",
      "model": "typesafe/jev-1.14",
      "effectiveFrom": "2026-01-01",
      "inputPerMTok": 0.042,
      "outputPerMTok": 0,
      "currency": "USD"
    }
  ]
}
```

**Configuration notes:**

- **Avoid `provider` collisions.** Give the `system-one` connection a distinct `provider` (for example, `openrouter-system-one`) if another entry in `models.connections` already uses `provider: "openrouter"` for `chat-completions` or `open-responses`.
- **Confirm the model ID on OpenRouter.** OpenRouter model IDs can vary by release (for example, `typesafe/jev-1.14` or `jev-1.13`); use the exact model ID listed by OpenRouter.
- **Using an environment variable instead of the secret store.** Replace `"apiKeySecret": "openrouter-api-key"` with `"apiKeyEnv": "OPENROUTER_API_KEY"`.
- **Optional `pricing` entry.** If the server response does not include a cost field, adding an entry under `pricing` matching the connection's `provider` and model `id` lets `/cost` and spend budgets calculate usage cost.

## Managing judging models from the CLI and terminal UI

From the shell:

```sh
momonga models role list
momonga models role set <role> <model> --yes
momonga models role clear <role> --yes
```

Pass `classifier` as `<role>` and `openrouter-system-one/typesafe/jev-1.14` as `<model>`.

In an interactive session:

- Judging models do not appear in the session `/model` picker. Open `/model` and choose `Model settings…` (or open `Models` inside `/config`) to inspect or edit judging roles.
- Run `/auto-mode` to inspect or change the `auto` mode classifier.
- Run `/memory auto on` to enable memory auto review, `/memory auto model` to choose `memory.autoReviewModel`, and `/memory auto` to inspect the current state.

## Verifying the setup

Check that the model is registered with its declared context window:

```sh
momonga models
```

Run the built-in `auto` mode check against your classifier and view stored results:

```sh
momonga auto-mode check openrouter-system-one/typesafe/jev-1.14
momonga auto-mode status
```

Run a quick headless prompt in `auto` mode:

```sh
momonga -p "list the files in this folder" --permission-mode auto
```

In a trusted folder with `memory.autoReview` enabled, inspect memories waiting for or reviewed by the judging model with:

```sh
momonga memory review
momonga memory show <id>
```

See [Configuration](guide.md#6-configuration) for all connection fields, [Settings keys](reference.md#settings-keys) for schema details, and [Slash commands](reference.md#slash-commands) for interactive commands.
