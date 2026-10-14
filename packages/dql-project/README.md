# `@zlens/project`

Registry and project primitives for DQL blocks.

Use this package to store, search, version, and certify DQL blocks in memory or SQLite-backed registries.

## Install

```bash
pnpm add @zlens/project
```

## Example

```ts
import { MemoryStorage, RegistryClient } from '@zlens/project';

const registry = new RegistryClient(new MemoryStorage());

await registry.register({
  id: 'block_1',
  name: 'revenue_by_segment',
  domain: 'finance',
  type: 'custom',
  version: '1.0.0',
  status: 'draft',
  gitRepo: 'github.com/acme/analytics',
  gitPath: 'blocks/revenue_by_segment.dql',
  gitCommitSha: 'abc123',
  owner: 'analytics',
  tags: ['finance'],
  dependencies: [],
  usedInCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const block = await registry.getByName('revenue_by_segment');
console.log(block?.status);
```

## Common Uses

- maintain a block registry for certification workflows
- build search and discovery features for reusable blocks
- track versions, ownership, and usage metadata

## Learn More

- Root docs: [`../../README.md`](../../README.md)
