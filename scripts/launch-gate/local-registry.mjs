// A local npm registry for the launch gate: it serves the packed release
// tarballs as if they were published, and passes every other request through
// to the public registry.
//
// With npm pointed at it (npm_config_registry), `npm install`, `npx
// create-zlens-app@X.Y.Z` and the samples' own package.json behave exactly as
// they will after the release: the release packages resolve to the packed
// tarballs, at their version, under the `latest` dist-tag, and third-party
// packages come from registry.npmjs.org. Nothing is published anywhere.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const UPSTREAM = 'https://registry.npmjs.org';

/** Read package/package.json out of a .tgz with the system tar. */
export function readTarballManifest(file) {
  const result = spawnSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read package.json from ${file}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Load every .tgz in `dir` into { name → { version, manifest, file, integrity, shasum } }. */
export function loadTarballs(dir) {
  const packages = new Map();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.tgz')) continue;
    const file = join(dir, entry);
    const manifest = readTarballManifest(file);
    const bytes = readFileSync(file);
    packages.set(manifest.name, {
      version: manifest.version,
      manifest,
      file,
      fileName: entry,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
    });
  }
  return packages;
}

/** The packument npm sees: the public one (if any) with the packed version added as `latest`. */
export function buildPackument(local, upstream, baseUrl) {
  const { manifest } = local;
  const doc = upstream && typeof upstream === 'object' && upstream.versions
    ? JSON.parse(JSON.stringify(upstream))
    : { name: manifest.name, versions: {}, 'dist-tags': {}, time: {} };
  const { scripts, devDependencies, ...published } = manifest;
  doc.versions[local.version] = {
    ...published,
    _id: `${manifest.name}@${local.version}`,
    dist: {
      tarball: `${baseUrl}/-/gate/${encodeURIComponent(local.fileName)}`,
      integrity: local.integrity,
      shasum: local.shasum,
    },
  };
  doc['dist-tags'] = { ...(doc['dist-tags'] ?? {}), latest: local.version };
  const now = new Date().toISOString();
  doc.time = { ...(doc.time ?? {}), [local.version]: now, modified: now };
  return doc;
}

/**
 * Start the registry on 127.0.0.1:`port`. Returns { url, stop, requests }.
 * `requests` lists the local packages npm asked for, as evidence.
 */
export async function startLocalRegistry({ tarballDir, port, log = () => {} }) {
  const packages = loadTarballs(tarballDir);
  const baseUrl = `http://127.0.0.1:${port}`;
  const requests = [];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', baseUrl);
      if (url.pathname.startsWith('/-/gate/')) {
        const fileName = decodeURIComponent(url.pathname.slice('/-/gate/'.length));
        const local = [...packages.values()].find((entry) => entry.fileName === fileName);
        if (!local) { res.writeHead(404).end(); return; }
        requests.push(`tarball ${fileName}`);
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(local.file));
        return;
      }
      // Packument requests: /name, /@scope%2fname or /@scope/name.
      const name = decodeURIComponent(url.pathname.slice(1));
      const local = packages.get(name);
      if (req.method === 'GET' && local) {
        requests.push(`packument ${name}`);
        const upstream = await fetch(`${UPSTREAM}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null);
        const body = JSON.stringify(buildPackument(local, upstream, baseUrl));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
        return;
      }
      // Everything else goes to the public registry unchanged.
      const headers = {};
      if (req.headers.accept) headers.accept = req.headers.accept;
      const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, { method: req.method, headers });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' };
      res.writeHead(upstream.status, outHeaders).end(buffer);
    } catch (error) {
      log(`registry error for ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `${baseUrl}/`,
    packages,
    requests,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
