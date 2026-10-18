import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test.each([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
])("host-provided package %s is a wildcard peer, not a runtime dependency", (name) => {
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

  expect(manifest.peerDependencies?.[name]).toBe("*");
  expect(manifest.dependencies ?? {}).not.toHaveProperty(name);
  expect(manifest.optionalDependencies ?? {}).not.toHaveProperty(name);
});
