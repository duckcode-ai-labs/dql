# Release process

ZLens uses one version across its publishable packages. The current version is
`0.1.0` (see `apps/cli/package.json`), the first release under the ZLens
package names. The packages it replaces (`@duckcodeailabs/*`,
`create-dql-app`) ended at `1.17.2`; their last git tag is `v1.14.3-rc.1`,
because `1.13.5` to `1.17.2` were published by hand. The repository is
`duckcode-ai-labs/zlens` (renamed from `duckcode-ai-labs/dql`; GitHub
redirects the old URL).

The authoritative npm publication path is the `vX.Y.Z` or
`vX.Y.Z-prerelease` tag workflow in
[`.github/workflows/release.yml`](../../.github/workflows/release.yml). It runs
`scripts/release-packages.mjs`, which builds the workspace, rewrites
`workspace:*` dependencies to concrete versions for packing/publishing, and
restores the repo manifests afterward. The workflow runs only for the
`duckcode-ai-labs` owner, needs the `NPM_TOKEN` repository secret (mapped to
`NODE_AUTH_TOKEN`), and publishes with `--provenance` (it has
`id-token: write`). On GitHub Actions the script stops before building if
`NODE_AUTH_TOKEN` is missing. Provenance only works when the package's `repository.url` matches the
GitHub repository, so keep every manifest pointing at
`https://github.com/duckcode-ai-labs/zlens`.

The OpenLineage producer URI emitted in lineage events
(`packages/dql-openlineage/src`) also points at
`https://github.com/duckcode-ai-labs/zlens`.

The 18 release packages do not include the VS Code extension. Its npm name,
`dql-language-support`, reached 1.17.2 before the rename and is not continued on
the ZLens 0.x line; the extension ships as a `.vsix`. The Visual Studio
Marketplace listing is separate: it is published only from a
manual `workflow_dispatch` run with `publish_extension=true`.

Every dry run and publish must name an npm dist-tag explicitly. Stable versions
must use `latest`; prereleases (including release candidates) must use `next`.
The release script rejects a mismatched tag before it builds or publishes, and
passes the selected tag to every `pnpm publish` invocation. It also requires a
trusted `--expected-version` and refuses to build, pack, or publish unless all
18 release manifests exactly match it. The tag workflow derives that value from
the pushed `v...` Git tag.

| Release version | Required npm dist-tag | Example Git tag |
| --- | --- | --- |
| Stable | `latest` | `v1.14.3` |
| Prerelease / RC | `next` | `v1.14.3-rc.1` |

## Cut a Release

1. Update package versions and template CLI ranges to the target version.
2. Update `CHANGELOG.md`, `ROADMAP.md`, and `docs/oss-readiness-checklist.md`.
3. Run the release candidate gates:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
node scripts/check-doc-links.mjs
pnpm release:dry-run -- --tag latest --expected-version 1.7.0
```

For a prerelease candidate, replace `latest` with `next`:

```bash
pnpm release:dry-run -- --tag next --expected-version 1.7.0-rc.1
```

4. Commit the release candidate and push `main`. Let ordinary CI complete.
5. Create an annotated tag at that exact release commit and push it:

```bash
git tag -a v1.7.0 -m "v1.7.0"
git push origin v1.7.0
```

6. Monitor the tag workflow. It is the authoritative npm publication path.
   `pnpm release:dry-run` runs the same steps (build, pack every package,
   report what would be published or skipped) without publishing.
7. After a release candidate, point `next` at it and check `latest` did not
   move. The tag workflow already publishes an rc with `--tag next`, so run
   this only if `next` is wrong. Each command needs an npm login with publish
   rights on the `@zlens` scope:

```bash
npm dist-tag add @zlens/cli@1.7.0-rc.1 next
npm dist-tag ls @zlens/cli
```

   Repeat for each of the 18 packages (`npm dist-tag ls` shows the tags).
8. Smoke the published packages:

```bash
npx -p @zlens/cli@1.7.0 zlens --version
npx -p @zlens/cli@1.7.0 zlens --help
npx create-zlens-app@1.7.0 --help
```

Use the exact published prerelease version in the same commands for an RC. Do
not use `@latest` or `@next` as the post-publish proof: the release script's
own smoke uses the exact CLI package spec so a moving dist-tag cannot mask a
wrong publication.

For a release candidate (shown here with `1.14.3-rc.1`), record both
independent facts:

```bash
npx -p @zlens/cli@1.14.3-rc.1 zlens --version
npx -p @zlens/cli@1.14.3-rc.1 zlens --help
npx create-zlens-app@1.14.3-rc.1 --help
npm view @zlens/cli dist-tags.next
npm view create-zlens-app dist-tags.next
```

The first three commands prove the exact published artifacts. The last two
prove that `next` points to the release candidate. Neither check treats
`@latest` as evidence for an RC.

## Local same-SHA fallback

Use a local publish only when the tag workflow cannot publish and the
maintainer has explicitly authorized the fallback. It must run from a clean
checkout at the **exact SHA** named by the already-pushed release tag; do not
move, recreate, or retarget a tag to make a fallback easier.

Before running the fallback, confirm the tag, `HEAD`, package manifests, and
registry target version agree, then run:

```bash
git diff --check
git rev-parse HEAD
git rev-parse v1.7.0^{}
pnpm release:publish -- --tag latest --expected-version 1.7.0
```

The fallback publishes with your own npm login: run `npm login` first (an
account with publish rights on the `@zlens` scope and `create-zlens-app`) and approve the
OTP or web prompt when `pnpm publish` asks. It does not need `NODE_AUTH_TOKEN`;
that variable is only read on GitHub Actions. Check with `npm whoami`.

Use `--tag next --expected-version 1.7.0-rc.1` for an authorized prerelease
fallback. The script will reject a stable version with `next`, a prerelease
with `latest`, or any expected version that differs from the manifests.

Record that the packages came from the tagged SHA, investigate why the tag
workflow failed, and perform the same registry and install smoke checks. The
fallback does not make VS Code Marketplace publication automatic.

## Publishing Gotchas

- Use the release script or `pnpm publish`, not raw `npm publish`; workspace
  dependencies must be rewritten to concrete versions.
- Keep generated templates on the same CLI range as the release.
- The notebook React app is served by the CLI; the release script builds the
  workspace before packing so the CLI ships fresh notebook assets.
- The VS Code extension is not published to npm with the other packages. The
  `.vsix` and the Marketplace listing ship separately, only from an
  explicit `workflow_dispatch` run with `publish_extension=true`.
- Provenance is added only when `GITHUB_ACTIONS=true`. The local same-SHA
  fallback publishes without it.

## What Ships

| Artifact | Where |
| --- | --- |
| npm packages (18, with provenance) | `npmjs.com/org/zlens` (17 `@zlens/*` packages), plus `create-zlens-app` |
| `create-zlens-app` templates | npm tarball |
| Notebook app assets | bundled inside `zlens` |
| VS Code extension | Marketplace |
| Docs | `docs/` in this repo, published to <https://duckcode-ai-labs.github.io/zlens/> by `.github/workflows/docs.yml` on every push to `main` |

Homebrew tap and desktop/Tauri binaries are not part of the OSS release path.
