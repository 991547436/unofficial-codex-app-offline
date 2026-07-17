"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const patchScriptPath = path.join(repoRoot, "scripts", "patch-app-asar.mjs");
const patchScriptSource = fs.readFileSync(patchScriptPath, "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadPatchHelper() {
  const functionStart = patchScriptSource.indexOf(
    "function patchTrustedBrowserClientHashesInContent",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\n// end patchTrustedBrowserClientHashesInContent",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "trusted browser-client hash helper is missing");
  assert.notEqual(functionEnd, -1, "trusted browser-client hash helper terminator is missing");

  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  return Function(
    "escapeRegExp",
    `"use strict";\n${helperSource}\nreturn patchTrustedBrowserClientHashesInContent;`,
  )(escapeRegExp);
}

const patchTrustedBrowserClientHashesInContent = loadPatchHelper();
const oldHash = "5b74180ac40ca4cf726cad15c5ff886f159224f1c0306ea364ad9eea6a7e7ac2";
const secondHash = "7ed52dae165c3bc22b6d24f282e2c1fbc87f6949fbbe037767a7418d8f517f01";
const patchedHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("patches the legacy standalone var declaration", () => {
  const source =
    `var bt=[\`${oldHash}\`,\`${secondHash}\`],xt=1;` +
    "function f({trustedBrowserClientSha256s:h=bt}){}";
  const result = patchTrustedBrowserClientHashesInContent(source, patchedHash);

  assert.equal(result.found, true);
  assert.equal(result.patched, true);
  assert.ok(result.content.includes(`\`${patchedHash}\`]`));
});

test("patches a hash array folded into a comma-separated var declaration", () => {
  const source =
    `var Dt=class{},Ot=[\`${oldHash}\`,\`${secondHash}\`],kt=1;` +
    "function f({trustedBrowserClientSha256s:h=Ot}){}";
  const result = patchTrustedBrowserClientHashesInContent(source, patchedHash);

  assert.equal(result.found, true);
  assert.equal(result.patched, true);
  assert.match(result.content, new RegExp(`,Ot=\\[.*${patchedHash}`));

  const secondPass = patchTrustedBrowserClientHashesInContent(
    result.content,
    patchedHash,
  );
  assert.equal(secondPass.alreadyCorrect, true);
  assert.equal(secondPass.patched, false);
  assert.equal(secondPass.content, result.content);
});

test("does not patch unrelated 64-character hash arrays", () => {
  const source =
    `var unrelated=[\`${oldHash}\`];` +
    "function f({trustedBrowserClientSha256s:h=trusted}){}";
  const result = patchTrustedBrowserClientHashesInContent(source, patchedHash);

  assert.equal(result.found, false);
  assert.equal(result.patched, false);
  assert.equal(result.content, source);
});
