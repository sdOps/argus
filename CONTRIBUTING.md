# Contributing to Argus

Thanks for your interest! Contributions — bug reports, ideas, code, docs — are welcome.

## Setup

1. Install [mise](https://mise.jdx.dev) — it pins every tool and runs every task in this repo.
2. Fork and clone the repo.
3. Run `mise run install` — mise provisions Bun and installs all dependencies.

See [Prerequisites](README.md#prerequisites) in the README for the full list (Ollama, Docker, etc.).

## Development loop

```bash
mise run dev          # native: server + UI + demo services, hot-reload
mise run typecheck    # tsc --noEmit for server + UI
mise run test         # deterministic-seam tests (argus-server)
mise run infra:up     # full Docker stack (one command)
```

## Making changes

- **Typecheck before committing:** `mise run typecheck`
- **Run tests:** `mise run test` — all tests must pass.
- **CI mirrors these checks:** typecheck + UI build + server tests + Docker build (see `.github/workflows/ci.yml`).

### Code style

- TypeScript throughout; Bun runtime (no build step for `.ts` files).
- React + Tailwind for the UI.
- Follow the existing patterns — read [`ARCHITECTURE.md`](ARCHITECTURE.md) for the big picture.

## Pull requests

1. Create a branch from `main`.
2. Make your change with a clear commit message.
3. Open a PR against `main` with a description of **what** and **why**.
4. CI must pass. If typecheck or tests fail, fix before requesting review.

## Reporting issues

Open a GitHub issue with enough detail to reproduce: which mode (`dev`, `infra:up`, `infra:start`), what you expected, what happened, and any relevant logs.

## License

By contributing, you agree your work will be licensed under the [MIT License](LICENSE).