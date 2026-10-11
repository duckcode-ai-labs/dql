# Repo layout & build

> ~2 minutes · ends with a local dev loop

## Clone & install

```bash
git clone https://github.com/duckcode-ai-labs/dql.git
cd dql
pnpm install
```

Requires **pnpm 9+** and **Node 20+**.

## Layout

```
dql/
├── apps/
│   ├── cli/              # dql CLI entry
│   ├── dql-notebook/     # Vite + React notebook
│   ├── vscode-extension/ # VS Code extension
│   └── docs/             # Plain-markdown docs (this folder)
├── packages/
│   ├── dql-core/         # parser + AST + semantic + lineage
│   ├── dql-compiler/     # IR + emitters
│   ├── dql-runtime/      # query execution
│   ├── dql-connectors/   # active Databricks, DuckDB/file, and Snowflake drivers
│   ├── dql-governance/   # lint + certification
│   ├── dql-project/      # SQLite registry
│   ├── dql-lsp/          # language server
│   ├── dql-charts/       # chart specs
│   └── dql-ui/           # shared tokens + primitives
└── docs/                 # legacy md (migrating into apps/docs/)
```

## Common scripts

```bash
pnpm build         # turbo-driven full build
pnpm dev           # watch all packages
pnpm test          # vitest across packages
pnpm lint          # eslint + tsc --noEmit
pnpm -F @duckcodeailabs/dql-notebook-app dev   # just the notebook
pnpm -F @duckcodeailabs/docs dev               # just the docs site
```

## Running the CLI from source

```bash
pnpm -F @duckcodeailabs/dql-cli build
node apps/cli/dist/index.js --version
```

Or link it globally during dev:

```bash
cd apps/cli && pnpm link --global
dql --version    # now shells out to your local build
```
