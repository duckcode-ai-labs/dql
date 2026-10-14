# `@zlens/core`

Core language package for DQL.

It contains the lexer, parser, AST, semantic analysis, diagnostics, and formatter used by the CLI, compiler, and editor tooling.

## Install

```bash
pnpm add @zlens/core
```

## Example

```ts
import { parse, analyze } from '@zlens/core';

const source = `
block "Revenue by segment" {
  domain = "finance"
  type = "custom"
  status = "draft"
  description = "Revenue by segment."

  query = """
    select segment, sum(revenue) as revenue
    from revenue
    group by 1
  """
}
`;

const ast = parse(source, 'blocks/revenue_by_segment.dql');
const diagnostics = analyze(ast);

console.log(ast.statements.length);
console.log(diagnostics);
```

## Common Uses

- power editor tooling and syntax validation
- build custom DQL linters or formatters
- inspect DQL ASTs programmatically

## Learn More

- Language reference: [`../../docs/reference/language.md`](../../docs/reference/language.md)
- Root docs: [`../../README.md`](../../README.md)
