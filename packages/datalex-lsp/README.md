# `@zlens/datalex-lsp`

Language Server Protocol implementation for DataLex `*.model.yaml`,
`*.diagram.yaml`, and `*.relationship.yaml` files. Pairs with the existing
[`@zlens/dql-lsp`](../dql-lsp) so both halves of the
[manifest-spec](https://github.com/duckcode-ai/manifest-spec) interop pattern
have schema-aware diagnostics in editors.

## What it does today (v0.1)

- **Schema-aware diagnostics** — every `*.model.yaml` is validated against
  the bundled DataLex v3 model schema (`datalex-model.schema.json`).
  Required-field / type / pattern / enum errors surface as LSP diagnostics
  with best-effort line numbers.
- **Parse error reporting** — YAML syntax errors surface with the line and
  column from the underlying parser.

## What's coming (v0.2+)

- **Hover** showing schema descriptions for the field under the cursor.
- **Completion** for valid keys, entity types, dialects, and tags drawn
  from the schema.
- **Cross-file resolution** — relationships, glossary references, and
  contract ids resolved against other files in the project.

## Install

```bash
npm install -g @zlens/datalex-lsp
```

Then point your editor at the `datalex-lsp` binary.

### VS Code

Add to `.vscode/settings.json`:

```json
{
  "yaml.customTags": ["!ref"],
  "yaml.schemas": {
    "https://duckcode-ai.github.io/manifest-spec/v1/datalex-manifest.schema.json": ["**/*.manifest.json"]
  }
}
```

(Native VS Code extension is on the roadmap.)

### Neovim

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')
configs.datalex_lsp = configs.datalex_lsp or {
  default_config = {
    cmd = { 'datalex-lsp', '--stdio' },
    filetypes = { 'yaml' },
    root_dir = lspconfig.util.root_pattern('datalex.yaml', '.git'),
  },
}
lspconfig.datalex_lsp.setup({})
```

## Status

`v0.1.0` — early. Diagnostics on save work; advanced features are pending.
File issues at [duckcode-ai-labs/zlens/issues](https://github.com/duckcode-ai-labs/zlens/issues)
with the `area:datalex-lsp` label.
