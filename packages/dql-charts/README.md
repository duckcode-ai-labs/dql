# `@zlens/charts`

React chart and content component library for ZLens.

It provides reusable chart renderers, themes, layout primitives, and notebook-style content blocks for building UI around compiled DQL results.

## Install

```bash
pnpm add @zlens/charts react react-dom
```

## Example

```tsx
import { BarChart } from '@zlens/charts';

export function RevenueChart() {
  return (
    <BarChart
      width={720}
      height={360}
      data={[
        { segment: 'Enterprise', revenue: 120000 },
        { segment: 'SMB', revenue: 64000 },
      ]}
      x="segment"
      y="revenue"
    />
  );
}
```

## Common Uses

- embed ZLens chart components in React apps
- reuse theme primitives across analytics views
- render chart, table, note, and narrative blocks consistently

## Learn More

- Root docs: [`../../README.md`](../../README.md)
