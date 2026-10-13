# `@zlens/dql-lsp`

Language-server primitives for DQL tooling.

This package powers completions, hover text, diagnostics, and editor integrations such as the DQL for ZLens VS Code extension.

## Install

```bash
pnpm add @zlens/dql-lsp
```

## Example

```ts
import { DQLLanguageService } from '@zlens/dql-lsp';

const service = new DQLLanguageService();

const diagnostics = service.validate(`
block revenue_by_segment {
  type = "custom"
  title = "Revenue by Segment"
}
`, 'blocks/revenue_by_segment.dql');

console.log(diagnostics);
```

## Common Uses

- build editor integrations for DQL
- provide completions and hover docs in custom IDE tooling
- surface diagnostics before compile time

## Learn More

- Root docs: [`../../README.md`](../../README.md)
