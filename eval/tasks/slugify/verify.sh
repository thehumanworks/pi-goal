#!/usr/bin/env bash
# Oracle for the slugify task. Runs in the sandbox cwd. Exit 0 iff achieved.
# The agent never sees this file.
set -euo pipefail

cat > .verify.test.ts <<'EOF'
import { slugify } from "./slug.ts";
const cases: [string, string][] = [
  ["  Hello,  World!! ", "hello-world"],
  ["Foo___Bar", "foo-bar"],
  ["--Already-Slug--", "already-slug"],
  ["a", "a"],
  ["   ", ""],
  ["", ""],
  ["Multiple   Spaces", "multiple-spaces"],
  ["Café del Mar", "caf-del-mar"],
  ["v2.0_release!", "v2-0-release"],
  ["...", ""],
];
let fail = 0;
for (const [inp, exp] of cases) {
  let got: unknown;
  try { got = slugify(inp); } catch (e) { console.error(`THREW on ${JSON.stringify(inp)}: ${e}`); fail++; continue; }
  if (got !== exp) { console.error(`FAIL slugify(${JSON.stringify(inp)}) = ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); fail++; }
}
if (fail) { console.error(`${fail} failure(s)`); process.exit(1); }
console.log("all pass");
EOF

bun .verify.test.ts >&2
rc=$?
rm -f .verify.test.ts
exit $rc
