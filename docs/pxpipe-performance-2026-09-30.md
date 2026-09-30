# Profilazione pxpipe — 30 settembre 2026

Il progetto usava `pxpipe-proxy` **0.13.2**. È stato aggiornato a **0.14.0** in
`package.json`, `package-lock.json`, `bun.lock` e nell'installazione locale.
La build standalone è stata ricompilata con la nuova dipendenza.
La libreria usa ora `gpt-tokenizer` 4.0.0; il conteggio del progetto mantiene
la propria dipendenza diretta 3.4.0.

La profilazione identifica un problema riproducibile nel conteggio diagnostico
dei dati opachi. L'aggiornamento da solo non elimina questo caso lento.
La modifica alle statistiche e il multithreading descritti sotto sono esperimenti
isolati, non modifiche al proxy gestito in esecuzione.

## Ambiente e metodo

- Windows, Node.js 22.22.1, Intel i7-10700K: 8 core e 16 processori logici.
- RAM: circa 64 GiB. GPU: NVIDIA RTX 2080 Ti, 11 GiB.
- Benchmark HTTP locale esistente: 10 fixture Responses per modello,
  `gpt-6-astra` e `anthropic/claude-opus-5-5`, preset `none` e `pxpipe`.
- Profili CPU V8 tramite Inspector, intervallo di campionamento 1 ms; misura
  del tempo trascorso, CPU e ritardo massimo di un timer da 10 ms.
- Input di stress: fixture sintetica `responses-dense-context` da circa 149 kB,
  con un elemento `reasoning.encrypted_content` aggiunto; confronto fra base64
  pseudocasuale e una sequenza ripetitiva di `A` della stessa lunghezza.
- Nessuna chiamata a provider: i tempi sono locali e non includono una risposta LLM.

Le misure di stress sono singole osservazioni controllate, non una distribuzione
di latenza del traffico reale. I nomi `cold` dei file indicano cache del renderer
svuotata: la cache del tokenizer rimane attiva nel processo. Claude viene misurato
per primo; il campione GPT successivo può riutilizzare la tokenizzazione dello
stesso input. Pertanto non dimostrano che il problema riguardi solo Claude.
I processi separati permettono invece il confronto delle due versioni sul primo
campione Claude.

## Confronto delle versioni

Sul corpus ordinario il benchmark completa tutte le 40 richieste per versione,
con controlli di conservazione superati. Alcuni costi vision rimangono sconosciuti:
non si deduce da questo test una migliore qualità semantica o un risparmio fatturato.

| Versione / modello | Mediana HTTP con pxpipe | p95 HTTP con pxpipe |
|---|---:|---:|
| 0.13.2 / Astra | 3,1 ms | 327,7 ms |
| 0.14.0 / Astra | 2,6 ms | 335,1 ms |
| 0.13.2 / Claude | 3,1 ms | 253,5 ms |
| 0.14.0 / Claude | 3,8 ms | 269,3 ms |

Dieci richieste eterogenee per riga e un solo round non consentono di attribuire
significato statistico alle piccole differenze. L'inizializzazione e le cache
influenzano soprattutto il caso di contesto denso.

Il problema emerge con sequenze opache lunghe e ripetitive:

| Input / versione | Trasformazione locale | Ritardo massimo del timer |
|---|---:|---:|
| 128 KiB ripetitivi / 0.13.2 | 9,749 s | 9,385 s |
| 128 KiB ripetitivi / 0.14.0 | 9,667 s | 9,334 s |
| 256 KiB ripetitivi / 0.14.0 | 51,636 s | 51,265 s |
| 512 KiB base64 pseudocasuale / 0.14.0 | 0,870 s | 0,516 s |
| 512 KiB base64 in blocco immagine sintetico di tool / 0.14.0 | 0,665 s | 0,343 s |

Quindi conta anche la forma dei dati, non soltanto la dimensione. Lo stress con
`A` ripetute è intenzionalmente patologico; non rappresenta automaticamente una
cifratura o una PNG reale.

## Dove viene speso il tempo

In `pxpipe-proxy/dist/core/openai.js`, `transformOpenAIResponses` chiama
`measureResponsesComposition` prima della trasformazione. Questa funzione esegue
il tokenizer su `JSON.stringify(reasoning)`, includendo `encrypted_content`;
inoltre serializza alcuni output di tool contenenti immagini.

Il conteggio serve alla diagnostica della composizione. Nel caso ripetitivo:

- 128 KiB: **95,7%** dei campioni CPU è in `BytePairEncodingCore`.
- 256 KiB: **98,9%** dei campioni CPU è in `BytePairEncodingCore`.

`bytePairMerge` scansiona ripetutamente i ranghi per trovare il minimo ed elimina
elementi dagli array con `splice`. Su un pezzo molto lungo e ripetitivo questo
produce lavoro quadratico. La versione 4.0.0 del tokenizer mantiene questa
struttura: il suo aggiornamento non risolve il caso osservato.

La cache di tokenizzazione può nascondere il costo su un input identico già visto.
L'input cambiato nel test multithread forza nuovi conteggi. Un timer fermo per
oltre 51 secondi dimostra che la trasformazione può impedire al thread HTTP di
gestire tempestivamente altre connessioni, header e stream.

Questo fornisce una spiegazione plausibile dei ritardi del dashboard del 29
settembre. Non abbiamo profilato il payload esatto di quelle richieste: non è
ancora provato che contenessero lo stesso pattern patologico.

## Esperimento: evitare il conteggio dei dati opachi

Una copia separata di pxpipe 0.14.0 filtra `encrypted_content` e i blocchi immagine
**solo dalla copia usata per la diagnostica**. La richiesta originale continua
intatta nella trasformazione e nell'inoltro.

| Input Claude | 0.14.0 originale | Copia sperimentale | Accelerazione |
|---|---:|---:|---:|
| 128 KiB ripetitivi | 9,667 s | 0,415 s | circa 23× |
| 256 KiB ripetitivi | 51,636 s | 0,381 s | circa 135× |

Per il caso 256 KiB, gli SHA-256 dei payload in uscita coincidono in tutti e
quattro i confronti Claude/GPT, renderer freddo/caldo. Il probe controlla anche
la conservazione del reasoning opaco, delle immagini native e del modello.

Questa è una prova del margine di ottimizzazione, non una patch pronta per la
produzione: la diagnostica filtrata diventerebbe parziale. Una correzione stabile
deve dichiarare esplicitamente i byte opachi esclusi e non presentare il subtotale
come conteggio completo. Deve coprire anche compaction e altri media serializzati.
È preferibile una modifica nell'API upstream; una patch manuale a `node_modules`
verrebbe persa alla reinstallazione.

## Esperimento: due worker thread persistenti

I worker vengono inizializzati e riscaldati prima della misura. Le due richieste
hanno sequenze opache da 128 KiB diverse tra loro, per evitare un cache hit sul
pezzo lento; gli stessi input vengono poi inviati ai due worker. Un'asserzione
confronta gli hash degli output sequenziali e paralleli.

| Esecuzione | Tempo per il gruppo | Ritardo del thread principale |
|---|---:|---:|
| Due richieste sequenziali nel thread principale | 24,180 s | 12.185,5 ms |
| Una richiesta in un worker | 13,710 s | 16,0 ms |
| Due richieste in due worker | 13,777 s | 13,6 ms |

Il gruppo parallelo è **circa 1,75× più rapido**, con output identici. Il beneficio
più importante è la reattività del proxy: il thread delle connessioni continua
a lavorare mentre il tokenizer occupa altri core. Una singola richiesta non
diventa automaticamente più veloce solo spostandola in un worker.

Un'integrazione dovrebbe partire da due worker persistenti, una coda limitata,
propagazione degli errori e delle cancellazioni, e assegnazione stabile delle
sessioni per sfruttare le cache. Ogni worker ha tokenizer, atlanti e cache propri:
non conviene partire da 16 worker soltanto perché ci sono 16 processori logici.
I worker di Cloudflare citati da pxpipe sono un ambiente di esecuzione, non
l'implementazione Node `worker_threads`.

## GPU, cache e altre ottimizzazioni

La RTX 2080 Ti è disponibile, ma la libreria distribuita non espone un backend
GPU. Il renderer e i filtri PNG sono JavaScript; la compressione usa
`CompressionStream`. `@napi-rs/canvas` è una dipendenza di sviluppo upstream,
non il renderer nativo usato a runtime.

La GPU non elimina il conteggio diagnostico BPE. Nel caso da 256 KiB, anche
azzerando tutto il tempo fuori dal tokenizer il margine sarebbe solo circa
**1,1%**. Non è una misura di accelerazione GPU: è un limite ricavato dalla
composizione dei campioni CPU di questo caso. Un renderer GPU richiederebbe una
nuova implementazione e confronti di pixel, leggibilità e costi di trasferimento.

La cache delle immagini **esiste già**, con budget Node predefinito di 64 MiB.
Nei probe risulta un miss seguito da un hit, senza eviction o oggetti fuori budget.
Aumentarne il limite non risolve il conteggio opaco. Per molte richieste identiche
contemporanee, deduplicare i render in corso potrebbe evitare doppio lavoro;
il vantaggio va misurato sul traffico reale prima di aggiungere questa logica.

Ordine degli interventi:

1. Evitare la tokenizzazione di dati opachi/media per sola osservabilità,
   mantenendo metriche parziali dichiarate e payload intatti.
2. Isolare la trasformazione dal thread HTTP con un piccolo pool persistente.
3. Se rimane un costo importante sul testo reale, confrontare un tokenizer
   nativo o un algoritmo BPE più efficiente; nessun guadagno è stato misurato qui.
4. Ottimizzare renderer/cache soltanto se diventano dominanti dopo i primi passi.

## Verifiche e artefatti

- `npm test`: completato con exit code 0 dopo l'aggiornamento.
- `npm run build`: completato; nuova build in `dist/aih.exe`.
- Benchmark HTTP delle due versioni: 40/40 richieste riuscite ciascuno.
- `git diff --check`: superato.
- Durante i benchmark: nessuna chiamata a provider, installazione globale o riavvio dei servizi gestiti.

Gli input e i profili locali sono in
`benchmark-results/pxpipe-profile-2026-09-30/` (directory ignorata da Git):

- `core/report.md` e `updated-core/report.md`: benchmark HTTP prima/dopo.
- `probe.mjs`: misure e controlli eseguibili.
- `prepare-experiment.mjs`: creazione della copia sperimentale.
- `new-opaque-repeated-262144.json` e `sanitized-opaque-repeated-262144.json`.
- `new-opaque-repeated-262144-claude-cold.cpuprofile`: profilo V8 apribile nei DevTools.
- `new-threads.json`: confronto dei worker e hash degli output.

Esempi di ripetizione dalla root, con gli artefatti già presenti:

```powershell
node benchmark-results/pxpipe-profile-2026-09-30/probe.mjs --case opaque-repeated-262144
node benchmark-results/pxpipe-profile-2026-09-30/probe.mjs --sanitized --case opaque-repeated-262144
node benchmark-results/pxpipe-profile-2026-09-30/probe.mjs --case opaque-repeated-131072 --threads
```

La build locale aggiornata non sostituisce automaticamente il worker di un proxy
già avviato dall'installazione globale.

Per caricare la libreria aggiornata occorre installare ai-helper 1.2.11 e
riavviare il proxy con `aih restart proxy --json`. Aggiornare soltanto il pacchetto
globale `pxpipe-proxy` non aggiorna necessariamente la copia incorporata in
ai-helper o in un vecchio binario standalone. Su Windows, se il processo è stato
avviato con privilegi elevati, il riavvio richiede una PowerShell con gli stessi
privilegi; nel controllo locale la terminazione è stata negata con `Access is denied`.

Fonti primarie: [release pxpipe 0.14.0](https://github.com/teamchong/pxpipe/releases/tag/v0.14.0),
[Node.js 22: worker thread e pool persistenti](https://nodejs.org/docs/latest-v22.x/api/worker_threads.html).
Le misure e le conclusioni prestazionali sopra derivano dai profili locali.
