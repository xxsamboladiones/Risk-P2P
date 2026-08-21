import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "apps", "desktop", "build");
const sourcePath = path.join(buildDir, "icon.base64.txt");
const destinationPath = path.join(buildDir, "icon.png");

const source = (await readFile(sourcePath, "utf8")).replace(/\s+/g, "");
const icon = Buffer.from(source, "base64");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

if (icon.length < 1024 || !icon.subarray(0, 8).equals(pngSignature)) {
  throw new Error("Asset do ícone do Risk não é um PNG válido.");
}

if (icon.length < 24 || icon.toString("ascii", 12, 16) !== "IHDR") {
  throw new Error("PNG do ícone do Risk não possui IHDR válido.");
}

const width = icon.readUInt32BE(16);
const height = icon.readUInt32BE(20);
if (width < 256 || height < 256 || width !== height) {
  throw new Error(`Ícone do Risk precisa ser quadrado e ter pelo menos 256 px (recebido ${width}x${height}).`);
}

await mkdir(buildDir, { recursive: true });
await writeFile(destinationPath, icon);
console.log(`Ícone desktop preparado em ${destinationPath} (${width}x${height}, ${icon.length} bytes)`);
