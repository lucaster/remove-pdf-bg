#!/usr/bin/env node
/**
 * Server statico senza dipendenze per la build di produzione.
 *
 *   node scripts/serve-dist.mjs [--port 8080] [--host 0.0.0.0]
 *
 * Serve `dist/ts-angular/browser` come farebbe un host statico (Netlify,
 * Cloudflare Pages, nginx): MIME types corretti, fallback SPA su index.html.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../dist/ts-angular/browser', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function parseArgs(argv) {
  const options = { port: 8080, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') options.port = Number(argv[++i]);
    else if (argv[i] === '--host' || argv[i] === '-h') options.host = argv[++i];
  }
  return options;
}

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = join(ROOT, normalize(clean).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT + sep) && target !== ROOT) return null;
  try {
    const info = await stat(target);
    if (info.isDirectory()) return resolveFile(join(clean, 'index.html'));
    return target;
  } catch {
    return null; // percorso inesistente: si risponde con index.html (SPA)
  }
}

const { port, host } = parseArgs(process.argv.slice(2));

const server = createServer(async (req, res) => {
  const file = (await resolveFile(req.url ?? '/')) ?? join(ROOT, 'index.html');
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`Build servita da ${ROOT}`);
  console.log(`http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
