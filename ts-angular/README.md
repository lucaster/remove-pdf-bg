# remove-pdf-bg — GUI Angular (browser-only)

Versione **Angular/TypeScript** della GUI NiceGUI (`python-nicegui`): una **SPA
interamente client-side** che analizza un PDF, ne individua le immagini di sfondo
e le rimuove, senza backend e senza upload dei file.

Il nucleo di analisi e rimozione è lo stesso della CLI TypeScript (`ts-cli`),
portato in browser: il risultato è **pixel-identico** a quello delle altre
implementazioni (verificato con PyMuPDF a 50 e 120 DPI sul PDF di prova del
repository, 22 pagine).

## Requisiti

- Node.js 20+ (sviluppato con Node 26)
- npm 10+
- Per i test end-to-end: `npx playwright install chromium`

## Avvio

```bash
cd ts-angular
npm install
npm start          # http://localhost:4200
```

## Test

I test coprono tre livelli:

| Livello | Comando | Cosa verifica |
|---|---|---|
| Unità | `npm run test:unit` | `pdf/core.ts` (parsing pagine, analisi, rimozione, dry-run) e `pdf/image-decoder.ts` (filtri, predictor, colori) con vitest |
| Componenti | `npm run test:unit` | `App`, `CandidateCardComponent`, `PdfSessionService` con Angular TestBed (jsdom) |
| End-to-end | `npm run test:e2e` | Scenari reali in Chromium con Playwright: upload, analisi, anteprime, rimozione, download, dry-run, errori |

```bash
npm run test:all    # unità + componenti + end-to-end
```

Gli scenari E2E avviano automaticamente il dev server Angular su
`http://localhost:4300` (configurato in `playwright.config.ts`) e generano i PDF
di prova in `e2e/fixtures/` tramite `e2e/global-setup.ts`.

I test unitari girano su jsdom, che non implementa il canvas: `src/testing/setup.ts`
fornisce un contesto 2D, `ImageData` e `createImageBitmap` finți, così il codice
di generazione delle anteprime viene eseguito davvero senza dipendenze native.

Su GitHub, `.github/workflows/ci.yml` esegue unit test e E2E (in parallelo) su
push e pull request che toccano `ts-angular/`; `.github/workflows/pages.yml`
pubblica la build su GitHub Pages solo se CI è verde, usando lo SHA testato.

## Comandi

```bash
npm run build       # build di produzione in dist/ts-angular/browser
npm run preview     # serve la build come un host statico (http://localhost:8080)
npm run watch       # build in modalità watch (sviluppo)
npm start           # dev server
```

## Pubblicare la build

La build è **statica**: `dist/ts-angular/browser` contiene tutto il necessario
(`index.html`, bundle JS/CSS e gli asset di pdf.js: worker, cmaps, font, wasm) e
può essere pubblicata su qualsiasi host statico — Netlify, Cloudflare Pages,
Vercel, GitHub Pages, nginx.

Confronto dei piani gratuiti e istruzioni per ogni host: **[DEPLOY.md](DEPLOY.md)**.

```bash
npm run build
npm run preview                    # prova locale: http://localhost:8080
npm run preview -- --port 9000     # porta diversa
npm run preview -- --host 0.0.0.0  # raggiungibile dagli altri dispositivi in rete
```

`npm run preview` usa `scripts/serve-dist.mjs`, un server statico senza
dipendenze che imposta i MIME type corretti (in particolare `application/javascript`
per i file `.mjs` del worker pdf.js) e fa fallback su `index.html`.

Attenzioni:

- **HTTPS**: la File System Access API funziona solo in un contesto sicuro.
  `http://localhost` va bene; un indirizzo di rete locale in chiaro
  (es. `http://192.168.1.10:8080`) **no** — in quel caso il pulsante
  "Salva come..." viene nascosto e resta disponibile solo il download. Per provare
  l'app da un telefono o da un dominio pubblico serve un tunnel HTTPS
  (es. `cloudflared tunnel --url http://localhost:8080`).
- **Sottopercorsi**: la build usa `<base href="/">`. Per pubblicarla in una
  sottocartella (es. `https://utente.github.io/progetto/`) compilare con
  `ng build --base-href /progetto/`.
- Il server deve servire i file `.mjs` come `application/javascript`: con il
  solo `python -m http.server` il worker pdf.js non si carica e le anteprime di
  pagina restano vuote.

## Come funziona

1. **Upload** — il file viene letto in memoria con `File.arrayBuffer()`; nessun
   dato lascia il browser.
2. **Analisi** (`src/app/pdf/core.ts`) — `pdf-lib` carica il documento, lo scanner
   (`src/app/pdf/scanner.ts`, copiato da `ts-cli`) interpreta i content stream e
   calcola il bounding box di ogni immagine XObject disegnata. Le immagini la cui
   copertura supera la soglia (default 95%) diventano candidate.
3. **Anteprime** — l'immagine candidata viene decodificata in RGBA dal decoder
   scritto per il progetto (`src/app/pdf/image-decoder.ts`: Flate, LZW, ASCIIHex,
   ASCII85, RunLength, DCT, predictor PNG/TIFF, spazi di colore Gray/RGB/CMYK/
   Indexed/ICCBased) e resa su canvas; il contesto di pagina è renderizzato con
   `pdf.js` (worker, cmaps, font e wasm serviti come asset).
4. **Rimozione** (`applyRemoval`) — due strategie, come nella CLI:
   - immagine non condivisa → l'oggetto XObject viene sostituito con un'immagine
     1×1 trasparente (rimozione globale);
   - immagine condivisa con una pagina esclusa → viene rimossa solo dalla pagina
     corrente, cancellando l'operatore `/Name Do` dal content stream.
5. **Output** — il PDF viene serializzato in memoria e proposto come download
   (`<nome>_nobg.pdf`) o salvato con la **File System Access API** quando
   disponibile.

## Compatibilità del browser

La SPA usa solo API web standard, con l'unica eccezione della File System
Access API:

| Browser | Supporto |
|---|---|
| Chrome / Edge (desktop, ≥ 86) | completo, incluso "Salva come..." |
| Opera ≥ 91, Samsung Internet ≥ 29, Chrome Android / WebView ≥ 132 | completo |
| Brave | completo (flag `brave://flags/#enable-file-system-access-api`) |
| Firefox, Safari | funzionante: il pulsante "Salva come..." non viene mostrato (il browser non espone la File System Access API) e un avviso spiega che il file viene scaricato nella cartella di download |

`showSaveFilePicker` richiede un contesto sicuro (HTTPS o localhost) e
l'attivazione dell'utente: il pulsante "Salva come..." non può aprire il
dialogo se non viene cliccato direttamente.

## Struttura

```
src/app/
  pdf/
    scanner.ts         scanner dei content stream (copiato da ts-cli)
    core.ts            analisi, rimozione, serializzazione
    image-decoder.ts   decodifica delle immagini XObject in RGBA
    image-preview.ts   rasterizzazione su canvas
    page-preview.ts    rendering delle pagine con pdf.js
  services/
    pdf-session.service.ts   stato della sessione (signals) e orchestrazione
    file-save.service.ts     download e File System Access API
  components/
    candidate-card.component.ts  scheda di una candidata
  app.ts / app.html / app.css   interfaccia
src/testing/           helper per i PDF di prova (PNG encoder + fixture builder)
e2e/                   scenari Playwright
```

## Note

- L'analisi gira sul thread principale con `await` fra una pagina e l'altra, per
  non bloccare l'interfaccia; su un PDF di 22 pagine l'analisi richiede ~1 s.
- Il file viene letto in memoria prima dell'analisi: finché il caricamento non è
  finito il pulsante "Analizza PDF" resta disabilitato, così un PDF di grandi
  dimensioni non viene analizzato a metà.
- Le anteprime di pagina usano `pdf.js` e il suo worker: senza il worker non
  viene mostrata l'anteprima, ma l'analisi e la rimozione funzionano comunque.
- Il formato del file di output è quello di `pdf-lib`: i PDF non sono
  byte-identici a quelli prodotti dalle altre implementazioni, ma il rendering
  è identico.
