#!/usr/bin/env node
// Convenience command that prints the latest mirrored Windows x64 MSIX URL.
import { resolveGitHubReleaseAsset } from './resolve-store-bundle-url.mjs';

try {
  const resolved = await resolveGitHubReleaseAsset({
    repository: process.env.CODEX_APP_MIRROR_REPOSITORY || 'Wangnov/codex-app-mirror',
    assetPattern:
      process.env.CODEX_APP_MIRROR_ASSET_PATTERN || 'OpenAI.Codex_*_x64*.Msix',
    packageFamilyName:
      process.env.CODEX_PACKAGE_FAMILY_NAME || 'OpenAI.Codex_2p2nqsd0c76g0',
    timeoutMs: Number.parseInt(
      process.env.CODEX_GITHUB_RESOLVER_TIMEOUT || '120000',
      10,
    ),
    token:
      process.env.CODEX_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  });

  console.log(resolved.selected.href);
  console.log(`File: ${resolved.selected.fileName}`);
  console.log(`SHA256: ${resolved.selected.sha256}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
