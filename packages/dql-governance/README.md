# `@zlens/governance`

Governance helpers for testing, certification, policy checks, and cost estimation.

This package is useful when you want to turn DQL blocks into durable, reviewable analytics assets instead of one-off queries.

## Install

```bash
pnpm add @zlens/governance
```

## Example

```ts
import { TestRunner } from '@zlens/governance';

const runner = new TestRunner({
  async execute(sql) {
    return [{ value: sql.includes('42') ? 42 : 0 }];
  },
});

const result = await runner.runTests(
  [
    {
      name: 'revenue is positive',
      sql: 'select 42 as value',
      operator: '>',
      threshold: 0,
    },
  ],
);

console.log(result.passed, result.failed);
```

## Common Uses

- run DQL `tests {}` assertions in CI
- apply certification rules before promotion
- estimate cost and enforce policy checks

## Learn More

- Root docs: [`../../README.md`](../../README.md)
- CLI reference: [`../../docs/cli-reference.md`](../../docs/cli-reference.md)
