import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, "..", "public");
mkdirSync(pub, { recursive: true });

const logo = path.join(__dirname, "logo.svg");
const logoMaskable = path.join(__dirname, "logo-maskable.svg");
const og = path.join(__dirname, "og-image.svg");

async function png(src, size, out) {
  await sharp(src, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(path.join(pub, out));
  console.log("wrote", out);
}

await png(logo, 192, "icon-192.png");
await png(logo, 512, "icon-512.png");
await png(logo, 180, "apple-touch-icon.png");
await png(logoMaskable, 512, "icon-maskable-512.png");
await png(logoMaskable, 192, "icon-maskable-192.png");

// favicon.ico (multi-size ico via png frames 16/32/48)
const sizes = [16, 32, 48];
const buffers = await Promise.all(
  sizes.map((s) => sharp(logo, { density: 384 }).resize(s, s).png().toBuffer())
);
const pngToIco = (await import("png-to-ico")).default;
const ico = await pngToIco(buffers);
const { writeFileSync } = await import("node:fs");
writeFileSync(path.join(pub, "favicon.ico"), ico);
console.log("wrote favicon.ico");

// OG image
await sharp(og, { density: 384 }).resize(1200, 630).png().toFile(path.join(pub, "og-image.png"));
console.log("wrote og-image.png");

// copy raw svg as the site logo (for masked usage / <img>)
const { copyFileSync } = await import("node:fs");
copyFileSync(logo, path.join(pub, "logo.svg"));
console.log("wrote logo.svg");

console.log("done");
