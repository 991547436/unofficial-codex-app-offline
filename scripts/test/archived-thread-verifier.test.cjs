"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const verifierSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
  "utf8",
);
const functionStart = verifierSource.indexOf(
  "function archivedThreadListForcesStateDbOnly",
);
const functionEnd = verifierSource.indexOf(
  "\n// end archivedThreadListForcesStateDbOnly",
  functionStart,
);
assert.notEqual(functionStart, -1, "archived thread verifier helper is missing");
assert.notEqual(functionEnd, -1, "archived thread verifier helper terminator is missing");

const marker = "/*codex-offline:archived-threads-partial-list*/";
const helperSource = verifierSource.slice(functionStart, functionEnd);
const archivedThreadListForcesStateDbOnly = Function(
  "ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER",
  `"use strict";\n${helperSource}\nreturn archivedThreadListForcesStateDbOnly;`,
)(marker);

test("accepts the legacy archived-only useStateDbOnly expression", () => {
  const content =
    "let q={archived:n,useStateDbOnly:n?!0:r};" + marker;
  assert.equal(archivedThreadListForcesStateDbOnly(content), true);
});

test("accepts the current always-state-db expression", () => {
  const content =
    "let q={archived:n,useStateDbOnly:!0};" + marker;
  assert.equal(archivedThreadListForcesStateDbOnly(content), true);
});

test("rejects a marker whose patched function does not force state DB", () => {
  const content =
    "let q={archived:n,useStateDbOnly:r};" + marker +
    "let unrelated={useStateDbOnly:!0};";
  assert.equal(archivedThreadListForcesStateDbOnly(content), false);
});
