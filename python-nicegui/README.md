# Remove PDF Background - GUI (NiceGUI)

Interfaccia grafica cross-platform per la rimozione selettiva di immagini di sfondo da PDF.

## Funzionalità

- **Cross-platform** (Windows, macOS, Linux)
- **Selezione file nativa** ("Sfoglia dal disco"): il PDF di output viene salvato nella stessa cartella del file selezionato
- **Anteprima PDF e immagini**: mostra thumbnail delle immagini candidate e contesto della pagina
- **Selezione individuale** con checkbox per ogni immagine rilevata
- **Progress bar** durante analisi ed elaborazione, con conteggio in tempo reale delle immagini identificate
- **Dry-run** per testare senza modificare file
- **Selezione massiva** (Seleziona tutto / Deseleziona tutto / Inverti)

## Installazione

```bash
cd python-nicegui
pip install -r requirements.txt
```

## Avvio

```bash
python gui.py
```

L'app si aprirà automaticamente su [http://localhost:8080](http://localhost:8080).

## Test

```bash
cd python-nicegui
python -m pytest -q
```

- `test_core.py` - unit test della logica (parse pagine, analisi, rimozione)
- `test_e2e.py` - test end-to-end della GUI con `nicegui.testing.User` (upload, analisi, selezione, apply)

## Utilizzo

1. **Seleziona PDF** - Trascina o carica un file, oppure usa "Sfoglia dal disco" per aprire il dialogo file nativo di Windows: in questo caso l'output viene salvato **nella stessa cartella del PDF di partenza**
2. **Imposta opzioni** - Soglia di copertura (%) e pagine da escludere (formato `1,3,5-7,10-`)
3. **Analizza** - Scansiona il PDF per trovare immagini candidate (≥ soglia). Vengono mostrate con preview immagine + contesto pagina
4. **Seleziona** - Spunta solo le immagini che vuoi rimuovere (checkbox)
5. **Applica** - Premi "Rimuovi immagini selezionate". Il PDF risultante viene salvato con suffisso `_nobg.pdf` accanto al file di partenza (per gli upload, nella cartella `uploads/`)

## Note

- Non richiede installazione (nessun installer). È sufficiente eseguire lo script.
- Le immagini all'interno di Form XObject possono non essere rimovibili per singola pagina (come nella versione CLI).
- In modalità dry-run il file viene salvato con suffisso `_nobg_preview.pdf`.