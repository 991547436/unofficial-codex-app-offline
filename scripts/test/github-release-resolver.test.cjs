"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const resolverUrl = pathToFileURL(
  path.resolve(__dirname, "..", "resolve-store-bundle-url.mjs"),
).href;

const x64Asset = {
  name: "OpenAI.Codex_26.715.2305.0_x64__2p2nqsd0c76g0.Msix",
  browser_download_url: "https://github.com/example/releases/download/v1/app.Msix",
  digest: "sha256:f2715c5358c41f96b0556992ed03968b52d3f438221561cb648f11801a90899e",
  size: 734646412,
  created_at: "2026-07-17T02:17:17Z",
  updated_at: "2026-07-17T02:17:20Z",
};

test("GitHub asset glob selects only the Windows x64 MSIX", async () => {
  const { globToRegExp } = await import(resolverUrl);
  const pattern = globToRegExp("OpenAI.Codex_*_x64*.Msix");

  assert.equal(pattern.test(x64Asset.name), true);
  assert.equal(
    pattern.test("OpenAI.Codex_26.715.2305.0_arm64__2p2nqsd0c76g0.Msix"),
    false,
  );
  assert.equal(pattern.test(`${x64Asset.name}.blockmap`), false);
});

test("resolver skips draft and prerelease entries and returns SHA-256 metadata", async () => {
  const { selectReleaseAsset } = await import(resolverUrl);
  const releases = [
    { draft: true, prerelease: false, assets: [x64Asset] },
    { draft: false, prerelease: true, assets: [x64Asset] },
    { draft: false, prerelease: false, assets: [{ name: "Codex-mac-x64.dmg" }] },
    {
      id: 42,
      draft: false,
      prerelease: false,
      tag_name: "codex-app-26.715.21425",
      name: "Codex App Mirror 26.715.21425",
      html_url: "https://github.com/example/releases/tag/v1",
      published_at: "2026-07-17T02:18:07Z",
      assets: [x64Asset],
    },
  ];

  const result = selectReleaseAsset(releases);
  assert.equal(result.version, "26.715.2305.0");
  assert.equal(result.release.tagName, "codex-app-26.715.21425");
  assert.equal(
    result.selected.sha256,
    "f2715c5358c41f96b0556992ed03968b52d3f438221561cb648f11801a90899e",
  );
});

test("resolver refuses an unverified MSIX asset", async () => {
  const { selectReleaseAsset } = await import(resolverUrl);
  assert.throws(
    () => selectReleaseAsset([
      { draft: false, prerelease: false, assets: [{ ...x64Asset, digest: null }] },
    ]),
    /does not provide a SHA-256 digest/,
  );
});
