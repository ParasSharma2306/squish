# Squish README - Full Raw Content

> Convert, combine, and compress images and PDFs, entirely in your browser.

> [Sponsor this project](https://github.com/sponsors/ParasSharma2306)

![Stars](https://img.shields.io/github/stars/ParasSharma2306/squish?style=flat-square)
![Forks](https://img.shields.io/github/forks/ParasSharma2306/squish?style=flat-square)
![License](https://img.shields.io/github/license/ParasSharma2306/squish?style=flat-square)
![Version](https://img.shields.io/badge/version-v1.0.0-blue?style=flat-square)

---

## The Story

Squish started as a favor for my sister. She kept running into the same wall: a PDF form that needed to be under 2MB to submit, or a photo that needed to be a specific format before some website would accept it. Every tool she found online wanted her to upload the file to a stranger's server first. She just wanted something simple, free, and private.

So I built her one. It converts image formats, stitches images into a PDF, and compresses images or PDFs down toward a target file size, all of it running locally in the browser. Nothing ever leaves your device.

---

## Live

[squish.parassharma.in](https://squish.parassharma.in)

---

## Features

| Feature | Details |
|---------|---------|
| Format conversion | Convert between JPG, PNG, WebP, BMP, and AVIF (when your browser supports encoding it) using the Canvas API |
| Broad format input | Upload JPG, PNG, WebP, GIF, BMP, AVIF, or SVG source images |
| Image to PDF | Combine one or more images into a single PDF, with drag-to-reorder before export (touch-friendly move up/down controls too) |
| Image compression | Two modes: hit a **target size**, or squeeze as far as possible while staying **visually identical** (quality chosen per image against a measured SSIM floor, not a fixed slider) |
| Content-aware routing | Photographs go to a lossy codec; screenshots, diagrams and flat artwork take a lossless palette + [oxipng](https://github.com/shssoichiro/oxipng) route instead |
| PDF compression | Embedded images are rewritten in place — page structure, vector shapes and text stay untouched and selectable. Photos are downsampled to the DPI they are actually drawn at; scanned pages are detected and coded losslessly as bilevel CCITT Group 4 |
| Per-file reporting | Every file reports original size, new size, real % reduction, and which technique produced it |
| 100% private | Every conversion happens in your browser. Nothing is ever uploaded, ever. |
| No account needed | Open the page, drop a file, done. |
| Installable PWA | Add Squish to your home screen or desktop and use it offline |
| Mobile friendly | Fully responsive layout, works the same on phone, tablet, and desktop |
| Open source | MIT licensed, self-hostable, forkable |

---

## Privacy

- All processing happens in the browser via JavaScript and the Canvas API
- Your images and PDFs never leave your device
- No server receives any file content
- No file data is logged, stored, or transmitted anywhere
- Full policy: [squish.parassharma.in/privacy.html](https://squish.parassharma.in/privacy.html)

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React + TypeScript, built with Vite |
| Image processing | Canvas API for encoding, a hand-rolled SSIM implementation for quality decisions, median-cut palette quantization, plus a small hand-rolled BMP encoder |
| Lossless PNG | [oxipng](https://github.com/jamsinclair/jSquash) via WASM (~160 KB, loaded only when the PNG path is used) |
| Bilevel coding | Hand-rolled ITU-T T.6 (CCITT Group 4) encoder, ~300 lines, no WASM |
| PDF creation and compression | [pdf-lib](https://pdf-lib.js.org/) for structure rewriting and export, [pdf.js](https://mozilla.github.io/pdf.js/) for decoding embedded images and measuring their on-page placement |
| Batch downloads | [JSZip](https://stuk.github.io/jszip/) |
| PWA | [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) (manifest and offline service worker) |
| Hosting | Static build, deployable anywhere (Nginx on a VPS, Netlify, Vercel, GitHub Pages, and so on) |

**Squish is a fully static app.** `npm run build` outputs a folder of plain HTML, CSS, and JS with no server-side code, no API routes, and no database. Every conversion, PDF build, and compression pass runs in the visitor's own browser via the Canvas API, pdf-lib, and pdf.js. You can host it on literally any static file server or CDN, and it keeps working offline once installed as a PWA.

---

## How Compression Works

Squish picks a technique per file rather than applying one setting to everything, and reports what it actually did.

### Images

Every image is classified first. **Photographs** go through a lossy codec whose quality is binary-searched against a measured [SSIM](https://en.wikipedia.org/wiki/Structural_similarity) score, so the quality setting is derived per image instead of being a fixed number you guess at. The search runs on a downscaled proxy and the winner is then verified — and corrected — at full resolution, which keeps a 4 MP photo interactive.

**Screenshots, diagrams and flat artwork** take a lossless route: the palette is reduced by median cut only as far as the same similarity check allows, then oxipng rebuilds the file. Lossy codecs are actively bad at this content — they smear exactly the hard edges that carry the meaning.

In **target size** mode the same machinery is driven toward a byte budget instead, trading resolution first and quality second, because a modest resolution cut is usually invisible on screen while heavy quality loss shows up fast.

### PDFs

PDFs are rewritten in place. Page structure, vector content and text are never touched, so text stays sharp and selectable.

- **Scanned pages** are detected, thresholded with Otsu's method, and coded losslessly with **CCITT Group 4**. This is the single largest win on scanned documents: JPEG spends its bit budget describing ringing around every letter edge, while Group 4 codes each row as differences against the row above — which is exactly the structure a page of text has. Group 4 is only kept when it actually beats the JPEG alternative, since it loses on noisy or dithered scans.
- **Photographs** are downsampled to suit the size they are actually drawn at on the page, recovered from the content stream's transformation matrix — not whatever resolution the source over-provisioned. A 3000px image placed in a 300pt box is ~720 DPI; almost none of that survives being looked at.
- **Duplicate images and duplicate embedded font programs** are merged, unreferenced objects are garbage-collected, metadata, XMP and page thumbnails are stripped, and the file is rebuilt with compact object streams.

Only a PDF with no recompressible content, or a target too aggressive to reach any other way, falls back to rendering whole pages as images — which trades away text selectability for a hard size guarantee.

### On compression ratios

Results depend entirely on the file you start with. An already-optimised PNG may not shrink at all; an over-provisioned scanned PDF may shrink enormously. Squish reports the numbers it measured for *your* files and does not claim a fixed ratio. If a file cannot be improved, it says so and hands back the original untouched.

### Verifying it yourself

Three scripts measure the engine against generated inputs. Start the dev server (`npm run dev`), then:

```bash
node ccitt-roundtrip-check.mjs   # proves the Group 4 encoder round-trips pixel-exactly
node engine-benchmark.mjs        # image engine: real sizes, techniques, SSIM, timings
node pdf-benchmark.mjs           # PDF engine: scanned, over-provisioned and mixed documents
```

---

## Run Locally

Requires [Node.js](https://nodejs.org/) 18+.

```bash
git clone https://github.com/ParasSharma2306/squish.git
cd squish
npm install
npm run dev
```

Open the printed local URL in your browser. No environment variables, no backend, no database.

```bash
npm run build     # production build, output in dist/
npm run preview   # preview the production build locally
```

---

## Deploy on a VPS

Squish is a static build, so any static file host works (Netlify, Vercel, GitHub Pages, S3, and so on). Here's the manual route with Nginx and Certbot, building directly on the server, tested on Ubuntu 22.04+.

### 1. SSH into your server

```bash
ssh user@your-server-ip
```

### 2. Install Node.js and Nginx

```bash
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -
sudo apt install -y nodejs nginx
```

### 3. Clone and build the app

```bash
cd /var/www
sudo git clone https://github.com/ParasSharma2306/squish.git
sudo chown -R $USER:$USER /var/www/squish
cd /var/www/squish
npm install
npm run build
```

This produces `/var/www/squish/dist`, the folder Nginx will actually serve (the repo root also has `src/`, `node_modules/`, and so on, which shouldn't be exposed).

### 4. Configure Nginx

Create a new site config:

```bash
sudo nano /etc/nginx/sites-available/squish
```

Paste this:

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    root /var/www/squish/dist;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # The service worker and manifest must always be revalidated, or
    # installed PWAs will keep running a stale version after you deploy
    # an update.
    location = /sw.js {
        add_header Cache-Control "no-cache";
    }
    location = /manifest.webmanifest {
        add_header Cache-Control "no-cache";
    }

    # Hashed build assets are safe to cache forever.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/squish /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Your site is now live on port 80 at your server IP.

### 5. Point a domain at it and add SSL with Certbot

In your DNS provider, add an A record:

```
Type: A
Name: squish (or @ for a bare domain)
Value: your-server-ip
TTL: Auto
```

Wait for DNS to propagate (a few minutes to an hour), then install Certbot:

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d squish.yourdomain.com
```

Follow the prompts. Certbot updates your Nginx config for HTTPS and sets up auto-renewal automatically.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Visit `https://squish.yourdomain.com`. You should see Squish over HTTPS with a valid certificate.

### Redeploying after a change

```bash
cd /var/www/squish
git pull
npm install
npm run build
```

No Nginx reload needed since the config still points at the same `dist/` folder. The service worker checks for updates on load and isn't itself cached, so installed users pick up the new version the next time they open the app.

---

## Contributing

PRs are welcome.

- Issues: open on GitHub
- PRs: open against `main`
- Keep it dependency-light and keep everything client-side. That's the whole point of Squish.

---

## License

MIT. Built by [Paras Sharma](https://parassharma.com)

## Sponsors

A special thank you to everyone who supports Squish through GitHub Sponsors. This table and the sponsors carousel on the live site will grow as more people sponsor.

| Sponsor | Amount |
| --- | ---: |
| [nicolevdw](https://github.com/nicolevdw) | $30 |
| [Dikshita Biswas](https://github.com/DikshitaBiswas) | $5 |

[Become a sponsor](https://github.com/sponsors/ParasSharma2306)

---

## Other Projects

More free, open-source, privacy-first tools from [parassharma.com](https://parassharma.com):

- [ChatLume](https://chatlume.parassharma.in): free, open-source WhatsApp/Instagram chat viewer
- [Calcify](https://calcify.parassharma.in): free, open-source calculator