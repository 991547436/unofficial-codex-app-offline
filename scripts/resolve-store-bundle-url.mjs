import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPOSITORY = 'Wangnov/codex-app-mirror';
const DEFAULT_ASSET_PATTERN = 'OpenAI.Codex_*_x64*.Msix';

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;

    const key = current.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = 'true';
    }
  }

  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern) {
  const source = pattern
    .split('*')
    .map(part => part.split('?').map(escapeRegExp).join('.'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i');
}

export function packageVersionFromFileName(fileName) {
  return fileName.match(/^OpenAI\.Codex_(\d+(?:\.\d+)+)_/i)?.[1] ?? null;
}

function sha256FromDigest(digest) {
  const match = typeof digest === 'string'
    ? digest.match(/^sha256:([a-f0-9]{64})$/i)
    : null;
  return match?.[1].toLowerCase() ?? null;
}

function normalizeAsset(asset) {
  return {
    fileName: asset.name,
    href: asset.browser_download_url,
    expiresAt: null,
    sha1: null,
    sha256: sha256FromDigest(asset.digest),
    digest: asset.digest ?? null,
    size: asset.size ?? null,
    createdAt: asset.created_at ?? null,
    updatedAt: asset.updated_at ?? null,
  };
}

export function selectReleaseAsset(releases, assetPattern = DEFAULT_ASSET_PATTERN) {
  const assetRegex = globToRegExp(assetPattern);

  for (const release of releases) {
    if (release.draft || release.prerelease) continue;

    const candidates = (release.assets ?? [])
      .filter(asset => assetRegex.test(asset.name ?? ''))
      .sort((left, right) =>
        String(right.updated_at ?? right.created_at ?? '').localeCompare(
          String(left.updated_at ?? left.created_at ?? ''),
        ) || String(left.name).localeCompare(String(right.name)));
    if (candidates.length === 0) continue;

    const selected = normalizeAsset(candidates[0]);
    if (!selected.sha256) {
      throw new Error(
        `GitHub asset ${selected.fileName} does not provide a SHA-256 digest.`,
      );
    }

    const version = packageVersionFromFileName(selected.fileName);
    if (!version) {
      throw new Error(`Could not parse MSIX package version from ${selected.fileName}.`);
    }

    return {
      release: {
        id: release.id,
        tagName: release.tag_name,
        name: release.name,
        htmlUrl: release.html_url,
        publishedAt: release.published_at,
      },
      selected,
      candidates: candidates.map(normalizeAsset),
      version,
    };
  }

  throw new Error(
    `No stable GitHub release contains an asset matching ${assetPattern}.`,
  );
}

async function fetchJson(url, { timeoutMs, token }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'codex-offline-builder',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      throw new Error(
        `GitHub Releases API returned HTTP ${response.status}` +
        (rateLimitRemaining === '0' ? ' (rate limit exhausted)' : ''),
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveGitHubReleaseAsset({
  repository = DEFAULT_REPOSITORY,
  assetPattern = DEFAULT_ASSET_PATTERN,
  packageFamilyName,
  timeoutMs = 120000,
  token,
}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid resolver timeout: ${timeoutMs}`);
  }

  const [owner, repo] = repository.split('/');
  const releasesUrl =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/releases?per_page=20`;
  const releases = await fetchJson(releasesUrl, { timeoutMs, token });
  if (!Array.isArray(releases)) {
    throw new Error('GitHub Releases API returned an unexpected response.');
  }

  const resolved = selectReleaseAsset(releases, assetPattern);
  return {
    source: 'github_release',
    repository,
    packageFamilyName,
    assetPattern,
    resolvedAt: new Date().toISOString(),
    ...resolved,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeoutMs = Number.parseInt(
    args.timeout || process.env.CODEX_GITHUB_RESOLVER_TIMEOUT || '120000',
    10,
  );
  const resolved = await resolveGitHubReleaseAsset({
    repository:
      args.repository || process.env.CODEX_APP_MIRROR_REPOSITORY || DEFAULT_REPOSITORY,
    assetPattern:
      args['asset-pattern'] || process.env.CODEX_APP_MIRROR_ASSET_PATTERN ||
      DEFAULT_ASSET_PATTERN,
    packageFamilyName:
      args['package-family-name'] || process.env.CODEX_PACKAGE_FAMILY_NAME || null,
    timeoutMs,
    token:
      process.env.CODEX_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  });

  process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
