# Benchmark dei flow del proxy

Il benchmark confronta **gli stessi input** attraverso i preset reali `none`,
`headroom`, `rtk`, `pxpipe`, `headroom-pxpipe`, `rtk-pxpipe`,
`rtk-headroom-pxpipe`. Non legge né azzera
le statistiche del proxy quotidiano e non cambia client, configurazioni o servizi.
`none` viene sempre aggiunto come baseline. Il preset `rtk-headroom-pxpipe`
esegue **RTK → Headroom → pxpipe** sul risultato dello stadio precedente; i tre
stadi sono riportati separatamente. La doppia compressione può perdere fatti:
Headroom non può recuperare informazioni già eliminate da RTK. Il nuovo preset
non viene selezionato automaticamente nel proxy quotidiano.

## Avvio rapido

Richiede Node.js compatibile con il progetto e dipendenze installate. Il runner
si esegue dal checkout con Node, non nel binario Bun compilato.

```powershell
# Smoke test senza Headroom, RTK o provider esterni
npm run bench:proxy -- --presets none,pxpipe --formats responses --warmup 0 --repetitions 1

# Tutti i sette flow; Headroom deve essere già disponibile a questo indirizzo
npm run bench:proxy -- --headroom-url http://127.0.0.1:8787 --repetitions 5 --warmup 1

# Stessi casi Responses attraverso HTTP e WebSocket
npm run bench:proxy -- --presets none,rtk,pxpipe,rtk-pxpipe --formats responses --transports http,ws

# Elenca oppure esporta il corpus per modificarlo
npm run bench:proxy -- --list
npm run bench:proxy -- --formats responses --export-fixtures my-fixtures.json
npm run bench:proxy -- --fixtures my-fixtures.json --out benchmark-results/my-experiment

# Test automatici del sistema (nessuna chiamata a provider reali)
npm run test:benchmark
```

RTK richiede un eseguibile con `rtk pipe` su PATH. Headroom usa esclusivamente
`POST /v1/compress`, in `lossy_inline`, con eventuale `HEADROOM_PROXY_TOKEN`.
Il runner non avvia/installa questi servizi: se mancano, registra **errori** per
i flow interessati, continua gli altri e termina con codice 2.
Le chiamate reali possono incrementare le metriche interne di Headroom/RTK e
scaldare le loro cache; restano invece isolate le statistiche del proxy aih gestito.

**Pxpipe nel benchmark è opt-in sui modelli del corpus**, anche se il gate di
default del proxy normale li escluderebbe. Questo serve a esercitare davvero i
flow con immagini: non è una garanzia di supporto o qualità del modello. Con
`--models` si può specificare l'allowlist esatta da testare; i `model_excluded`
rimangono visibili in `stageReasons`. Nessuna configurazione di produzione cambia.

`--rtk-filter` applica un filtro fisso a tutti i tool output: usarlo soltanto su
un corpus omogeneo compatibile. Senza flag viene usata l'autodetection.

## Cosa viene misurato

### Replay offline (default)

Ogni preset ha un proxy reale su una porta loopback effimera, con un collector
locale come upstream. Il collector osserva il payload effettivamente inoltrato.
Non vengono effettuate chiamate LLM. Headroom, se selezionato, riceve i testi da
comprimere: un `--headroom-url` remoto comporta l'invio a quel servizio.

Il corpus integrato contiene **30 fixture sintetiche**, 10 scenari per Responses,
Chat Completions e Anthropic Messages: build, test, stack trace, log, grep, git,
JSON, output breve e contesto statico denso. Non contiene dati di lavoro reali.

- Ordine di casi e flow randomizzato con seed riproducibile.
- Default: 1 round di warmup e 3 misurati per caso/flow/trasporto.
- Warmup conservati nei record ma esclusi dalle aggregazioni.
- HTTP misura il round-trip fino al collector, inclusa la trasformazione.
- WS usa una nuova connessione per campione Responses e misura separatamente
  handshake (`connectionMs`) e round-trip del messaggio (`durationMs`).
- `firstRequest` identifica la prima richiesta al proxy del benchmark, **non**
  un vero avvio a freddo di RTK, Headroom, librerie o cache del provider.
- `meta.startup` misura l'inizializzazione dei proxy. Non equivale al tempo di
  avvio di processi esterni; per misurarlo serve una campagna separata controllata.

I risultati sono separati per **modello, protocollo e trasporto**, anche per
categoria nel JSON. Headroom riceve solo tool text per Responses, ma i messaggi
per Chat/Messages: non bisogna confrontare percentuali di scope diversi.

### Conteggio uniforme

I conteggi dichiarati da Headroom/RTK/pxpipe sono conservati in `stages` soltanto
come diagnostica. La metrica comune viene ricalcolata prima e dopo il proxy:

- testo e struttura JSON canonica: tokenizer `o200k_base` identico per ogni flow;
- tool text: conteggio separato dei soli risultati testuali;
- immagini PNG: dimensioni IHDR e profilo vision della versione pxpipe installata
  per famiglie OpenAI riconosciute con detail esplicito `high`/`original`;
- base64, dati cifrati e media non vengono conteggiati come testo;
- modello/dettaglio/formato immagine non misurabile, media opachi o resize non
  modellato ⇒ totale **null / sconosciuto**, mai zero. `knownTokens` è soltanto
  il subtotale noto della stima locale, non una garanzia sul consumo del provider.

Questi sono **token stimati**, non l'esatta serializzazione del provider né una
fattura. Per le immagini Anthropic/Gemini non viene inventato un costo OpenAI.
Il trasferimento di testo in immagini non è considerato un risparmio totale del
100%: `toolText` resta diagnostico, mentre il totale include il costo vision o è
sconosciuto. `imageMeasurements` e `warnings` spiegano le approssimazioni.

La percentuale aggregata è ponderata:

```text
100 × (somma token prima − somma token dopo) / somma token prima
```

Non è la media delle percentuali. Errori, output invariati, risparmi negativi e
costi sconosciuti rimangono visibili. La copertura indica quante richieste hanno
un confronto completo; un totale parziale non può vincere la selezione automatica.

### Qualità offline

Ogni fixture dichiara fatti che devono sopravvivere: codice di errore, file/riga,
valori JSON, identificatore del test, ecc. Vengono controllati anche modello,
nomi dei tool e coppie call/result native presenti nell'originale.

Gli esiti sono `pass`, `fail`, `indeterminate`, `unscored`. Se un fatto non è più
testo ma potrebbero contenerlo le immagini, l'esito è `indeterminate`: nessun OCR
o modello ha verificato che sia leggibile. Il runner **non dichiara un vincitore
di qualità sulla base del solo replay offline**. La presenza delle stringhe è
un controllo di conservazione, non una prova di comprensione o correttezza.

## Valutazione live, esplicita e potenzialmente a pagamento

### Suite qualità e richieste con immagini native

`--suite core` resta il default storico: 30 fixture, 10 per protocollo.
`--suite quality` aggiunge un corpus **opt-in di 12 casi Responses**, destinato
anche al confronto Astra/Fable. `--suite all` unisce i due corpora (42 fixture
prima dei filtri/modelli). Il file passato con `--fixtures` è alternativo a
`--suite`: non viene mescolato implicitamente con casi integrati.

La suite qualità contiene:

- 2 casi con regole in istruzioni lunghe, non nel tool output: recupero di un
  fatto e rispetto della priorità delle istruzioni rispetto a una nota del tool;
- 2 diagnostici di build, in fondo e in mezzo a output rumoroso, con risposta
  JSON esatta comprendente errore, file, riga, colonna ed exit code;
- 1 campo assente per verificare l'astensione invece dell'invenzione di un valore;
- 7 casi con PNG nativi: singolo, multiplo/ordine, storico più allegato corrente,
  risultato di tool, testo contraddittorio, detail low e controllo breve.

I PNG sono pixel deterministici di pannelli sintetici con codici leggibili,
senza metadati testuali o URL che contengano la soluzione. Sono **test di OCR e
associazione**, non una valutazione generale di foto, diagrammi o screenshot.
Le risposte attese e `evaluation.evidence` restano fuori da `body`, quindi non
vengono inviate ai modelli. Nessuna immagine remota viene scaricata dal benchmark.

```powershell
# Ispezionare/esportare i 12 input prima di usarli; nessuna chiamata LLM
node scripts/bench-proxy.js --suite quality --formats responses --list
node scripts/bench-proxy.js --suite quality --formats responses --export-fixtures quality-fixtures.json

# Replay offline: 12 casi × 2 modelli × 4 flow = 96 campioni
npm run bench:models -- --suite quality --presets none,headroom,headroom-pxpipe,headroom-pxpipe-native-bypass --repetitions 1 --warmup 0
```

Gli alias **solo benchmark** `pxpipe-native-bypass`,
`headroom-pxpipe-native-bypass`, `rtk-pxpipe-native-bypass` e
`rtk-headroom-pxpipe-native-bypass` usano la ricetta reale corrispondente, ma
saltano **solo pxpipe** quando la richiesta originale contiene immagini native.
Il rilevamento avviene prima di RTK/Headroom, comprende contenuti multimodali e
risultati di tool; ignora schemi, metadata e JSON citato come testo. Lo stadio
registra `native_images_present`, non un risparmio vision inventato.

Gli alias non sono inclusi nei 7 flow di default e non cambiano la configurazione
quotidiana. I flow senza suffisso mantengono il comportamento precedente.
Headroom/RTK restano attivi dove applicabili: il bypass di pxpipe **non è una
garanzia** che un altro stadio preservi l'allegato. Anche questo viene verificato.
Con tutti gli 11 flow e i 2 modelli, la suite qualità richiede **264 campioni per
round**; aggiungere `--live` li renderebbe altrettanti tentativi provider.

Nuovi controlli e campi del report:

- `answerChecks.exact`: uguaglianza case-sensitive, ignorando soltanto whitespace
  iniziale/finale; niente spiegazioni aggiuntive;
- `answerChecks.jsonEquals`: JSON valido, nessun fence o prosa, stesso oggetto o
  array atteso, stessi tipi/valori e nessuna chiave extra; ordine delle chiavi
  irrilevante, chiavi duplicate rifiutate anche con escape Unicode;
- `answerChecks.maxChars`: tetto alla lunghezza, combinabile con gli altri check;
- `imageIntegrity`: hash del contenuto e di tutti gli attributi delle immagini
  native, molteplicità, ordine relativo, raggruppamento e associazione a ruolo,
  call ID e testo co-locato. Indici assoluti possono cambiare quando vengono
  inseriti messaggi sintetici. Un cambio del testo co-locato viene segnalato in
  modo conservativo, anche se una valutazione umana potrebbe ritenerlo innocuo;
- `addedOrChanged` conta immagini nuove **o native modificate**, non le presume
  tutte correttamente generate. `nativeImagesRetained` non è un punteggio vision;
- `evidence` distingue risposte ancora disponibili nel testo da casi che
  richiedono immagini native o renderizzate. Non è una validazione OCR.

Il selettore esclude un candidato con perdita/alterazione degli allegati anche
se la risposta supera i controlli. Nei casi dichiarati `rendered_context`, se
pxpipe si applica ma lascia la risposta nel testo (per esempio nella factsheet),
segnala `vision_evidence_not_discriminating`: quel pass non prova lettura delle
immagini. Una vera valutazione live rimane necessaria; il replay offline non
produce punteggi di comprensione visiva né sceglie un vincitore.

### GPT-6 Astra e Fable 5.1 sullo stesso corpus

Il comando dedicato seleziona gli ID del gateway `gpt-6-astra` e
`anthropic/claude-fable-5-1`, sul medesimo protocollo Responses:

```powershell
# Replay offline: 20 fixture × 7 flow = 140 campioni
npm run bench:models -- --repetitions 1 --warmup 0

# Smoke live: al massimo 140 chiamate complessive, senza retry del runner
npm run bench:models -- --live --responses-stream --upstream http://127.0.0.1:10100 --repetitions 1 --warmup 0 --max-live-calls 140 --stop-on-error

# Solo baseline e nuova combinazione: 10 casi × 2 flow × 2 modelli = 40 chiamate
npm run bench:models -- --presets none,rtk-headroom-pxpipe --live --responses-stream --upstream http://127.0.0.1:10100 --repetitions 1 --warmup 0 --max-live-calls 40
```

Richiede un gateway che supporti **entrambi i modelli via Responses**; un endpoint
Anthropic diretto non accetta questa combinazione. `--compare-models` permette
altre liste ed è distinto da `--models`, che controlla solo l'allowlist pxpipe.
I report mantengono baseline, latenza, qualità e usage **separati per modello**;
il limite chiamate si applica all'intera matrice, non a ciascun modello.

I costi vision locali per questi modelli non vengono ricavati arbitrariamente
da profili più vecchi: dove non supportati restano sconosciuti. La misura di
riferimento nel test live è l'usage restituito dal gateway/provider.

Gli upstream ChatGPT/Codex possono richiedere `stream: true` anche quando OCX
accetta sintatticamente il non-stream. Usare `--responses-stream`: il runner
consuma SSE fino all'evento terminale. Se il terminale omette l'output (come può
accadere con Astra), ricostruisce il testo dagli item finalizzati
`response.output_item.done`; l'usage proviene sempre dal terminale. I soli delta
non bastano a dichiarare una risposta completa. Stream
troncati o senza evento terminale restano errori, non risposte completate.

### Endpoint e credenziali

```powershell
# Impostare BENCH_API_KEY nell'ambiente, senza inserirla nella command line.
# L'upstream è la radice PRIMA di /v1: il percorso viene dalla fixture.
npm run bench:proxy -- --live --upstream http://127.0.0.1:10100 --api-key-env BENCH_API_KEY --formats responses --model gpt-5.5 --repetitions 3 --warmup 0
```

Scegliere un modello effettivamente supportato dal proprio upstream. Per un
endpoint Anthropic usare `--formats anthropic` e un modello Anthropic. Un corpus
multiformato live richiede un upstream che accetti tutti i protocolli selezionati.
Le credenziali sono opzionali per gateway locali che non le richiedono; non
vengono mai cercate automaticamente negli account o nei file dell'utente.

Il collector inoltra al provider **il payload realmente trasformato dal proxy**.
Con `--upstream http://127.0.0.1:10100` la catena è quindi
`runner → proxy privato del preset → collector privato → OCX`, **non** il proxy
quotidiano `rtk-pxpipe → OCX`. Il runner usa l'upstream esplicito, non quello del
client Codex; impostarlo invece alla porta del proxy quotidiano reintrodurrebbe
la doppia trasformazione. Le istanze proxy sono private, mentre OCX e il servizio
Headroom rimangono condivisi e non vengono riavviati o riconfigurati.
Ogni fixture pone una domanda con risposta nota contenuta nel tool output;
`answerChecks` valuta la risposta reale. I report includono:

- qualità della risposta per campione e tasso di pass;
- durata totale proxy + collector + provider, e durata del solo provider;
- input/output/cache read/cache write/reasoning dichiarati dal provider;
- risposta completa o troncata, tool aggiuntivi richiesti dal modello.

Per Anthropic l'input normalizzato comprende input non-cached + letture/scritture
cache, evitando di confrontare scope diversi. Campi non restituiti restano null.
Di default streaming viene disabilitato; `--responses-stream` lo abilita solo per
Responses. Le Responses hanno `store: false` e non usano background jobs,
Chat usa una singola completion, e le risposte
richiedono il limite `--max-output-tokens` (default 256). Il gateway/provider può
ignorarlo: l'adapter ChatGPT di OCX osservato rimuove `max_output_tokens`, quindi
non è una garanzia di budget. Vengono utilizzati bearer
auth per OpenAI-compatible e `x-api-key` per Anthropic; redirect sono bloccati.

**Non è un agente autonomo:** nessun tool viene eseguito, nessun retry o follow-up
automatico. Tool richiesti e risposte incomplete squalificano il candidato. La
modalità live accetta solo definizioni di tool function/client, non tool eseguiti
dal provider come web search o code interpreter. La
qualità misurata riguarda queste domande/fixture, non una completa attività di
coding. Per valutare task agentici servono sessioni controllate con repository
identico, test di accettazione e conteggio di tutte le riletture/retry; questo
runner non pretende di coprirli.

Warmup live **consumano token**. Il numero massimo pianificato di chiamate è:

```text
casi applicabili × flow (incluso none) × (warmup + repetitions)
```

Il numero viene mostrato prima delle chiamate; `--max-live-calls` (default 200)
blocca piani più grandi prima di inviare richieste. Per una campagna più ampia,
aumentare esplicitamente questo limite oppure ridurre corpus/rounds.
Il limite conta i tentativi HTTP del runner: eventuali retry o fallback interni
del gateway non sono sotto il suo controllo e vanno verificati nei log di OCX.

Non c'è controllo della cache remota: fissare modello/versioni/configurazioni e
ripetere le campagne. Ordine randomizzato riduce, ma non elimina, il bias della
cache e del carico. Una richiesta annullata può comunque essere fatturata senza
restituire usage: i report non rappresentano una fattura completa. L'abort del
campione viene propagato alla fetch del provider; non è una garanzia che il
provider interrompa il proprio lavoro.

## Fixture proprie

Esportare il corpus è il modo più semplice per partire. Il file deve essere un
array JSON di richieste standalone, già sanificate, senza header o credenziali.
Esempio minimo:

```json
[
  {
    "id": "incident-01",
    "category": "logs",
    "format": "responses",
    "path": "/v1/responses",
    "body": {
      "model": "gpt-5.5",
      "input": [
        {"type":"function_call","call_id":"c1","name":"read_log","arguments":"{}"},
        {"type":"function_call_output","call_id":"c1","output":"INFO ready\nERROR E_QUEUE_FULL at worker.ts:18"},
        {"role":"user","content":"Return the error code and source location."}
      ]
    },
    "checks": {"toolIncludes":["E_QUEUE_FULL","worker.ts:18"]},
    "answerChecks": {"includes":["E_QUEUE_FULL","worker.ts:18"],"excludes":["no errors"]}
  }
]
```

`checks.toolIncludes` cerca solo nei risultati dei tool; `requestIncludes` nel
testo nativo della richiesta. Le stringhe devono esistere già nell'originale.
`answerChecks.includes/excludes` sono confronti letterali case-sensitive, non un
LLM judge; `exact`, `jsonEquals` e `maxChars` consentono controlli più rigorosi.
Non inserire le risposte nella domanda. Omettere `answerChecks` lascia
la risposta non valutata, e impedisce una raccomandazione live. Le fixture
integrate includono definizioni/coppie dei tool complete; rispettare i vincoli
del proprio provider nelle fixture personalizzate. Non usare riferimenti a
stato remoto (`previous_response_id`) per un confronto standalone riproducibile.

## Report e decisioni

Ogni esecuzione crea una directory nuova, normalmente sotto `benchmark-results/`
(gitignored), senza sovrascrivere run precedenti:

- `report.md`: riepilogo leggibile e candidati;
- `report.json`: manifest/versioni/hash, tutti i campioni, aggregazioni e decisioni;
- `results.csv`: righe importabili in fogli di calcolo;
- `records.jsonl`: append progressivo, disponibile anche dopo un'interruzione.

Non vengono salvati prompt/output/credenziali di default; i valori attesi delle
asserzioni sono sostituiti con hash. Gli identificatori delle fixture/modelli e
gli endpoint configurati restano nel manifest: evitare segreti nei nomi/path.
`--save-payloads` abilita esplicitamente una sottodirectory con originali,
trasformati e risposte live, utile per ispezionare le regressioni e potenzialmente
**sensibile**. Non caricarla automaticamente su servizi esterni.

La selezione considera solo run live completi, campioni abbinati alla baseline,
senza errori, con usage completo e risposte valutate/complete. Soglie configurabili:

- `--max-quality-drop 0`: nessuna diminuzione ammessa del pass rate (punti percentuali);
- `--max-latency-regression 25`: aumento massimo del p95 rispetto a `none` (%).

Tra i candidati ammissibili, la **frontiera di Pareto** elenca quelli non dominati
su risparmio input dichiarato dal provider, p95 e pass rate. Non sceglie un peso
arbitrario tra qualità e velocità, non equipara token risparmiati a denaro e non
afferma significatività statistica. Con pochi campioni usare i risultati come
segnale esplorativo, poi aumentare corpus/ripetizioni e verificare le regressioni.

Il manifest registra seed, hash corpus, versioni locali di Node/RTK/pxpipe/tokenizer,
URL e configurazione scelta. `headroomLocalCli` **non certifica** la versione o i
flag di un servizio Headroom remoto: fissarli/annotarli esternamente per confronti
tra macchine o date diverse.

Exit code: **0** run completato senza errori di richiesta; **2** errori o
interruzione; **1** opzioni/setup non validi. Una regressione di qualità non
cambia da sola l'exit code: consultare `decisions`. Nessuna modifica è applicata
automaticamente al flow del proxy in uso.
