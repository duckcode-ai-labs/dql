# DQL for ZLens

VS Code extension for DQL with:

- Syntax highlighting for DQL files (`.dql`)
- Snippets for domains, enterprise-ready blocks, business views, terms, dashboards, and workbooks
- Language Server support (diagnostics, completion, hover, formatting)

## Development

```bash
pnpm --filter dql-language-support build
```

## Packaging

```bash
pnpm --filter dql-language-support package
```

This generates a `.vsix` artifact that can be installed in VS Code.
