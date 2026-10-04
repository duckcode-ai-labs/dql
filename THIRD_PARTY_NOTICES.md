# Third-party notices

DQL is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). It
ships the following third-party material under its own licence.

## Fonts

**Inter** 3.019, by The Inter Project Authors (https://github.com/rsms/inter),
licensed under the SIL Open Font License, Version 1.1.

- Source: `packages/dql-ui/src/styles/fonts/` (`inter-latin.woff2`,
  `inter-latin-ext.woff2`, Latin subsets of the upright variable font) with
  the licence text in `OFL.txt` beside them.
- Built app: the licence ships beside the font files as `Inter-OFL.txt`
  (`apps/dql-notebook/dist/assets/`, and in the CLI package under
  `dist/assets/dql-notebook/assets/`). Any app that loads the shared styles can
  do the same with the Vite plugin `@duckcodeailabs/dql-ui/font-licence`.

Code text uses JetBrains Mono only where the computer already has it, else the
system's monospace face; DQL does not ship that font.

## Packages

Every npm package DQL depends on carries its own licence in its package.
