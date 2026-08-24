# Squish README - Full Raw Content

> Convert, combine, and compress images and PDFs, entirely in your browser.

> [Sponsor this project](https://github.com/sponsors/ParasSharma2306)

![Stars](https://img.shields.io/github/stars/ParasSharma2306/squish?style=flat-square)
![Forks](https://img.shields.io/github/forks/ParasSharma2306/squish?style=flat-square)
![License](https://img.shields.io/github/license/ParasSharma2306/squish?style=flat-square)
![Version](https://img.shields.io/badge/version-v0.3.0--beta-orange?style=flat-square)

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
| Image compression | Enter a target size; Squish binary-searches JPEG/WebP/AVIF quality (and resolution, if needed) to land as close as possible |
| PDF compression | Enter a target size; Squish rasterizes pages with pdf.js and rebuilds the PDF with pdf-lib, binary-searching quality to land as close as possible |
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
| Image processing | Canvas API for format conversion and quality-search compression, plus a small hand-rolled BMP encoder |
| PDF creation and compression | [pdf-lib](https://pdf-lib.js.org/) for build and export, [pdf.js](https://mozilla.github.io/pdf.js/) for rendering pages during compression |
| Batch downloads | [JSZip](https://stuk.github.io/jszip/) |
| PWA | [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) (manifest and offline service worker) |
| Hosting | Static build, deployable anywhere (Nginx on a VPS, Netlify, Vercel, GitHub Pages, and so on) |

**Squish is a fully static app.** `npm run build` outputs a folder of plain HTML, CSS, and JS with no server-side code, no API routes, and no database. Every conversion, PDF build, and compression pass runs in the visitor's own browser via the Canvas API, pdf-lib, and pdf.js. You can host it on literally any static file server or CDN, and it keeps working offline once installed as a PWA.

---

## How Compression Works

For images, Squish binary-searches the quality parameter (for JPEG, WebP, and AVIF) until the output lands just under your target size. If the lowest quality is still too big, it progressively downscales the image and searches again. PNG and BMP have no quality knob, so they rely on the downscale step alone.

For PDFs, Squish decodes each embedded photo with pdf.js, downsamples and recompresses it as JPEG, and swaps it back into the original PDF object with pdf-lib — page structure, vector shapes, and text are never touched, so text stays sharp and selectable even when the file shrinks by two or three orders of magnitude. Only PDFs with no recompressible images (pure text/vector) or an unreachably aggressive target fall back to rendering whole pages as images, which trades away text-selectability for a hard size guarantee.

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

A special thank you to everyone who supports Squish through GitHub Sponsors. This table (and a matching section on the live site) will grow as more people sponsor.

| Sponsor | Amount |
| --- | ---: |
| Dikshita Biswas | $5 |

[Become a sponsor](https://github.com/sponsors/ParasSharma2306)

---

## Other Projects

More free, open-source, privacy-first tools from [parassharma.com](https://parassharma.com):

- [ChatLume](https://chatlume.parassharma.in): free, open-source WhatsApp/Instagram chat viewer