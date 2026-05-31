import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const artifacts = ["main.js", "manifest.json", "styles.css"];
const repoRoot = process.cwd();
const manifest = JSON.parse(
  await readFile(path.join(repoRoot, "manifest.json"), "utf8"),
);

const pluginId = manifest.id;
if (typeof pluginId !== "string" || pluginId.trim() === "") {
  throw new Error("manifest.json must define a non-empty plugin id.");
}

const directPluginDir = process.env.FLOWTIME_OBSIDIAN_PLUGIN_DIR;
const pluginsRoot = process.env.FLOWTIME_OBSIDIAN_PLUGINS_DIR;

if (!directPluginDir && !pluginsRoot) {
  throw new Error(
    "Set FLOWTIME_OBSIDIAN_PLUGINS_DIR to your vault .obsidian/plugins directory, " +
      "or FLOWTIME_OBSIDIAN_PLUGIN_DIR to the exact plugin install directory.",
  );
}

const targetDir = path.resolve(
  directPluginDir ?? path.join(pluginsRoot ?? "", pluginId),
);

for (const artifact of artifacts) {
  await access(path.join(repoRoot, artifact));
}

await mkdir(targetDir, { recursive: true });
await Promise.all(
  artifacts.map((artifact) =>
    copyFile(path.join(repoRoot, artifact), path.join(targetDir, artifact)),
  ),
);

console.log(`Synced ${pluginId} artifacts to ${targetDir}`);
