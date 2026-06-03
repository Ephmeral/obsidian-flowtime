import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));

if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
  throw new Error("package.json must define a non-empty version.");
}

manifest.version = packageJson.version;
versions[packageJson.version] = manifest.minAppVersion;

await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n\n`);
await writeFile("versions.json", `${JSON.stringify(versions, null, 2)}\n\n`);
