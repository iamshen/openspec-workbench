import { build } from "esbuild";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  external: ["obsidian"],
  legalComments: "inline",
  metafile: true,
  write: false,
});

const names = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const name = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(input)?.[1];
  if (name) names.add(name);
}

const notices = await Promise.all([...names].sort().map(async (name) => {
  const folder = "node_modules/" + name + "/";
  const license = (await readdir(folder)).sort().find((file) => /^licen[sc]e(?:\..+)?$/i.test(file));
  if (!license) throw new Error("Missing license for bundled package " + name);
  const pkg = JSON.parse(await readFile(folder + "package.json", "utf8"));
  return name + " " + pkg.version + "\n" + await readFile(folder + license, "utf8");
}));

const licenses = [await readFile("LICENSE", "utf8"), await readFile("NOTICE", "utf8"), ...notices]
  .map((notice) => notice.trim().replace(/\r\n/g, "\n"))
  .join("\n\n---\n\n")
  .replaceAll("*/", "* /");

await mkdir("dist", { recursive: true });
await writeFile("dist/main.js", "/*!\n" + licenses + "\n*/\n" + result.outputFiles[0].text);
await Promise.all(["manifest.json", "styles.css"].map(async (file) => {
  const source = await readFile(file, "utf8");
  await writeFile("dist/" + file, source.replace(/\r\n/g, "\n"));
}));
