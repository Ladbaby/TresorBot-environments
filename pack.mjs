#!/usr/bin/env node
// Packs each input into a release bundle and writes the digest list.
//
//   node pack.mjs
//
// A bundle is one JSON file: {"files": {"environment.json": "...", "environment.mjs": "..."}}.
// Sun verifies a bundle against its digest before writing anything, so the digest
// published here is what an operator passes to `tresorbot-sun input install`.
//
// The digest scheme must match TresorBot's internal/adapters.SourceDigest:
// filenames sorted, each entry framed as <len(name)>:<name><len(body)>:<body>.

import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceDigest } from "./digest.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const environmentsDir = join(root, "environments");
const distDir = join(root, "dist");

const MANIFEST = "environment.json";
const MAX_FILES = 256;
const MAX_BYTES = 4 << 20;

/**
 * Reports whether a directory is excluded from this catalogue.
 *
 * A directory can be present on disk and still not be published -- the reference
 * `echo` adapter is one. Asking git rather than keeping a second exclusion list
 * means .gitignore is the single place that decides what ships, so a bundle can
 * never be produced for something the repository does not contain.
 */
function isIgnored(dir) {
  try {
    execFileSync("git", ["check-ignore", "--quiet", relative(root, dir)], { cwd: root, stdio: "ignore" });
    return true;
  } catch (error) {
    // Exit code 1 means "not ignored". Anything else means git could not answer,
    // in which case publishing is the safe default: silently dropping an adapter
    // from a release is worse than publishing one the author meant to keep.
    return error.status === 0;
  }
}

/** Reads every file in an input directory, keyed by relative path. */
async function collect(dir, prefix = "") {
  const out = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // node_modules is an install-time artefact, not part of the input source.
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, await collect(full, rel));
      continue;
    }
    if (!entry.isFile()) continue;
    out[rel] = await readFile(full, "utf8");
  }
  return out;
}

await mkdir(distDir, { recursive: true });
const digests = [];
const entries = await readdir(environmentsDir, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = join(environmentsDir, entry.name);
  if (isIgnored(dir)) {
    console.log(`skip ${entry.name}: excluded by .gitignore`);
    continue;
  }
  const files = await collect(dir);
  if (!files[MANIFEST]) {
    console.error(`skip ${entry.name}: no ${MANIFEST}`);
    continue;
  }
  if (Object.keys(files).length > MAX_FILES) {
    console.error(`skip ${entry.name}: too many files`);
    continue;
  }
  const manifest = JSON.parse(files[MANIFEST]);
  const digest = sourceDigest(files);
  const asset = `${manifest.name.replaceAll("/", "-")}-${manifest.version}.json`;
  await writeFile(join(distDir, asset), JSON.stringify({ files }), "utf8");
  const size = (await stat(join(distDir, asset))).size;
  digests.push({ name: manifest.name, version: manifest.version, asset, digest, bytes: size });
  console.log(`packed ${manifest.name} ${manifest.version} -> dist/${asset} (${size} bytes)`);
  console.log(`  sha256 ${digest}`);
}

digests.sort((a, b) => a.name.localeCompare(b.name));
const lines = digests.map((d) => `${d.asset}  ${d.digest}  ${d.name}@${d.version}`);
await writeFile(join(distDir, "digests.txt"), lines.join("\n") + "\n", "utf8");
console.log(`\nwrote dist/digests.txt (${digests.length} environment${digests.length === 1 ? "" : "s"})`);
