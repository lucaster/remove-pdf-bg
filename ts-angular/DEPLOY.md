# Pubblicare la GUI Angular — opzioni gratuite

La GUI in `ts-angular/` è una **SPA completamente statica**: nessun backend e
nessun upload dei file. La build produce tutto il necessario in
`dist/ts-angular/browser` (circa **5,5 MB, 203 file**, il più grande
`pdf.worker.min.mjs` da 1,21 MB), quindi si pubblica su qualunque host statico.

```bash
cd ts-angular
npm run build       # -> dist/ts-angular/browser
npm run preview     # prova locale della build su http://localhost:8080
```

## Requisiti e avvertenze

1. **HTTPS** — la File System Access API (pulsante "Salva come...") funziona
   solo in un contesto sicuro. `http://localhost` va bene, un IP di rete locale
   in chiaro no: in quel caso la UI nasconde il pulsante e resta il download.
   Tutti gli host elencati sotto offrono HTTPS automatico.
2. **Sottopercorsi** — la build usa `<base href="/">`. Se il sito non sta alla
   radice del dominio (es. GitHub Pages: `https://utente.github.io/repo/`)
   compilare con `ng build --base-href /repo/` (o usare un dominio dedicato).
3. **MIME type** — il server deve servire i file `.mjs` come
   `application/javascript`, altrimenti il worker di pdf.js non si carica e le
   anteprime di pagina restano vuote. Gli host statici lo fanno; **non** usare
   `python -m http.server` (serve `.mjs` come `text/plain`).

## Confronto (piani gratuiti, ottobre 2026)

| Host | Limiti del piano free | Deploy | Note |
|---|---|---|---|
| **Cloudflare Pages** | banda e richieste statiche illimitate, 500 build/mese, 20.000 file, max 25 MiB/file, 100 domini | Git o `wrangler` | Migliore per un sito pubblico: la banda non finisce mai |
| **Netlify** | 300 crediti/mese (hard limit), 20 crediti/GB di banda, 15/deploy di produzione; a esaurimento i progetti si fermano | drag & drop, Git o CLI | Il più rapido per la prima pubblicazione |
| **Vercel (Hobby)** | 100 GB/mese, 1M richieste CDN | Git o `vercel` | Solo uso **personale/non commerciale** |
| **GitHub Pages** | repo pubblico, sito max 1 GB, ~100 GB/mese (soft) | GitHub Actions o branch `gh-pages` | Richiede `--base-href` se il sito sta in sottocartella |
| **Firebase Hosting (Spark)** | 10 GB storage, 360 MB/giorno (~10,8 GB/mese) | `firebase deploy` | Banda più limitata |

Tutti includono HTTPS e dominio personalizzato gratuiti. I limiti cambiano:
verificare le pagine ufficiali prima di scegliere.

## Netlify — drag & drop (2 minuti)

1. `npm run build`
2. Aprire <https://app.netlify.com/drop>
3. Trascinare la cartella `ts-angular/dist/ts-angular/browser`
4. (Opzionale) Site settings → *Change site name* per avere
   `https://nome-scelto.netlify.app`

Alternative: `npx netlify deploy --prod --dir=dist/ts-angular/browser` dopo
`npx netlify login`.

## Cloudflare Pages

Via CLI (senza Git):

```bash
npm run build
npx wrangler pages deploy dist/ts-angular/browser --project-name remove-pdf-bg
```

Via dashboard con repository Git: *Workers & Pages → Create → Pages → Connect to
Git* e impostare:

- Build command: `cd ts-angular && npm ci && npm run build`
- Build output directory: `ts-angular/dist/ts-angular/browser`

Ogni push aggiorna il sito; ogni PR ottiene un'anteprima.

## Vercel

```bash
npx vercel login
npx vercel --prod
```

Impostazioni del progetto: Root Directory `ts-angular`, Framework *Angular*,
Build Command `npm run build`, Output Directory `dist/ts-angular/browser`.

> Il piano Hobby è riservato all'uso personale non commerciale.

## GitHub Pages (GitHub Actions)

Il repository ha già il remote `lucaster/remove-pdf-bg`, quindi il sito sarebbe
`https://lucaster.github.io/remove-pdf-bg/`: serve la build con
`--base-href /remove-pdf-bg/`. Il repo deve essere pubblico (o serve GitHub Pro).

1. *Settings → Pages → Build and deployment → Source: GitHub Actions*
2. Salvare `.github/workflows/pages.yml`:

```yaml
name: Deploy GUI to GitHub Pages

on:
  push:
    branches: [main]
    paths: ['ts-angular/**', '.github/workflows/pages.yml']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: ts-angular/package-lock.json
      - run: npm ci
        working-directory: ts-angular
      - run: npx ng build --base-href /remove-pdf-bg/
        working-directory: ts-angular
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ts-angular/dist/ts-angular/browser

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Con un dominio personalizzato alla radice, togliere `--base-href`.

## Firebase Hosting

```bash
npm i -g firebase-tools
firebase login
cd ts-angular && npm run build && cd ..
firebase init hosting    # public: ts-angular/dist/ts-angular/browser, SPA: Yes
firebase deploy --only hosting
```

## Consigli

- **Cloudflare Pages** è la scelta migliore per un sito pubblico (banda
  illimitata); **Netlify drag & drop** per pubblicare subito.
- Gli asset hanno un hash nel nome: cache lunga per loro, `no-cache` per
  `index.html` (gli host lo fanno già di default).
- Non serve configurare redirect per l'SPA: l'app non ha router.
- Dopo il deploy verificare: caricamento PDF, anteprime (worker `.mjs`),
  "Salva come..." (solo Chromium, su HTTPS) e download.
