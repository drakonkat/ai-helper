# Ripristino workstation Windows + Neden

Preparato l'11 settembre 2026. **Copia tutta questa cartella su un disco che non formatterai**: i due script usano `packages.csv` e `Neden.vsconfig` accanto a loro.

## Prima della formattazione: indispensabile

Questo e' un installer, **non un backup**. Prima verifica che i backup siano leggibili, soprattutto:

- **`D:\MMO\UE5.7`**: l'engine trovato e' **UE 5.7.4 da sorgenti, senza repository Git**. Conserva lo snapshot completo, modifiche locali e dipendenze. Non e' possibile ricostruire con certezza lo stesso engine da una revisione Git nota; la versione del Launcher non lo sostituisce.
- **`C:\Users\nbald\Perforce\Neden_NiccoloWorkspace`**: e' il percorso effettivo trovato, diverso da `Neden\_NiccoloWorkspace`. Conserva file non inviati al server, `Content`, `Source`, `Config`, `Plugins`, `.uproject`, `.vsconfig`, `.mcp.json`, impostazioni workspace e changelist pendenti. Una copia offline completa e' piu' prudente del solo sync; `Saved` puo' contenere autosave e lavoro non recuperabile dal depot.
- Configurazioni Perforce/P4V e dati di connessione; chiavi SSH, Git, Codex/Claude, configurazioni `.aih`, `.codex`, MCP, variabili ambiente. **Conserva segreti cifrati, fuori dal repository**: e' presente anche `login_keys.json` nel progetto; lo script non lo legge/copia.
- Export dei profili JetBrains, G HUB, SteelSeries GG, iCUE, ShareX, Ditto, PowerToys; preferiti browser, salvataggi Steam non sincronizzati, Google Drive realmente sincronizzato, eventuali volumi/database Docker e distribuzioni WSL. Un elenco di applicazioni non conserva questi dati.

Inventario Chocolatey rilevato: `git`, `nvm`, `ditto`, oltre a `maven`, `mingw`, `rust` e pacchetti interni Chocolatey. I primi tre sono inclusi nel catalogo; Maven/MinGW/Rust non sono requisiti osservati di Neden e non vengono reinstallati automaticamente. Per conservarne le versioni prima di formattare, in una cartella di backup scelta da te:

```powershell
choco list --limit-output | Set-Content .\chocolatey-installed.txt
choco export --output-file-path=.\chocolatey-packages.config --include-version-numbers
```

Non reimportare ciecamente vecchie versioni o pacchetti interni. Se ti servono ancora, con Chocolatey installato: `choco install maven mingw rust -y` (Maven richiede anche un JDK compatibile con i tuoi progetti).

## Avvio rapido

Target: **Windows 11 x64 aggiornato**, Windows PowerShell **5.1 x64**, Internet. Lo script principale funziona anche in PowerShell 7, ma l'helper UE viene eseguito con Windows PowerShell. Apri PowerShell **come amministratore del tuo stesso account**, non con un account amministrativo diverso: Store, NVM, npm e associazione engine hanno impostazioni per-utente.

Nella cartella copiata:

```powershell
# Anteprima: NON installa, NON scarica, NON scrive log/configurazioni.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Restore-Workstation.ps1

# Installa/configura tutte le fasi. Il bootstrap avviene solo se WinGet manca.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Restore-Workstation.ps1 -Apply -AcceptAgreements -BootstrapPackageManager
```

`-AcceptAgreements` autorizza l'accettazione delle licenze dei pacchetti. Verifica la tua idoneita' alle licenze Visual Studio Community, JetBrains e Docker. `-ExecutionPolicy Bypass` vale **solo per quel processo**, non cambia la policy permanente. Non vengono disabilitati Defender, UAC o controlli hash degli installer.

**Se viene richiesto un riavvio, fallo manualmente, poi ripeti lo stesso comando.** Docker viene rinviato quando WSL e' in attesa di riavvio. Nessun `Restart-Computer` automatico. Gli installer di terzi possono comunque presentare finestre/login: non e' un sistema completamente unattended.

Se WinGet non e' disponibile, puoi installare/aggiornare **App Installer** dal Microsoft Store. Il bootstrap alternativo usa il modulo ufficiale `Microsoft.WinGet.Client` da PSGallery. Non ripara Store bloccati dalle policy: in quel caso seguire il report.

## Cosa installa

- **Sviluppo:** Git, NVM for Windows, Node LTS x64 tramite NVM, `@drakonkat/ai-helper`, **OpenCodex (`@bitkyc08/opencodex`)**, **pxpipe (`pxpipe-proxy`)**, **`@agentmemory/agentmemory`**, JetBrains Toolbox, WebStorm, PhpStorm, Codex **Desktop**, Claude **Desktop**, Docker Desktop.
- **Personale:** Telegram, Steam, Discord, Teams attuale (accesso con account personale), Chrome, Brave, Google Drive.
- **Utility/periferiche:** Notepad++, G HUB, ShareX, SteelSeries GG, Ditto, PowerToys, iCUE 5.
- **WhatsApp Web:** collegamento nel menu Start che apre `https://web.whatsapp.com/` nel browser predefinito, **non WhatsApp Desktop**. Se preferisci una PWA installala dal browser; resta necessario il QR/login.
- **UE:** Perforce P4V (l'installer Windows comprende la CLI P4), VS **2022** con la configurazione salvata del progetto, prerequisiti UE e preparazione descritta sotto.
- **WSL2:** abilita WSL/VirtualMachinePlatform senza reboot automatico; dopo il riavvio aggiorna WSL e imposta versione 2. Non installa Ubuntu, non modifica firewall, gruppi privilegiati Docker o impostazioni BIOS.

I pacchetti sono nel CSV modificabile. Le versioni applicative vengono risolte dai cataloghi al momento dell'installazione; non e' un mirror offline. Le app gia' riconosciute dal package manager sono saltate, **non aggiornate o reinstallate forzatamente**. Restando sullo stesso manager lo script e' rieseguibile. Non alternare WinGet/Chocolatey su app gia' presenti: Chocolatey puo' non riconoscere un'installazione WinGet/manuale e duplicarla.

`NodeVersion=lts` risolve la LTS piu' recente dal catalogo ufficiale Node.js a ogni esecuzione: per risultati ripetibili specifica una versione esatta. Non installa Node standalone in parallelo a NVM, non cancella directory/symlink in conflitto. Le global npm appartengono alla versione Node selezionata. Per i quattro tool npm, `latest` conserva una copia gia' presente; per cambiarla indica `-AihVersion`, `-OpenCodexVersion`, `-PxpipeVersion` o `-AgentMemoryVersion` con una versione esplicita, oppure aggiorna con npm. Le installazioni mancanti usano la release corrente e verificano sia il pacchetto sia il comando sul PATH.

La fase **Node** predispone `aih`, `ocx`, `pxpipe` e `agentmemory`: **non viene avviato alcun servizio AI** durante il restore. Nel codice ai-helper corrente, `aih start` senza argomenti avvia **ocx, agentmemory e il proxy integrato con preset pxpipe**; il proxy ascolta su `127.0.0.1:10102` e inoltra a OpenCodex su `127.0.0.1:10100`. Il pacchetto standalone `pxpipe-proxy` richiesto e' installato anche per `aih start pxpipe` (porta 47821), ma non va confuso con il proxy integrato. Non servono due processi pxpipe per il semplice `aih start`.

Restano manuali il ripristino di chiavi, login/provider OpenCodex, configurazioni e dati agentmemory, plugin e l'eventuale **Headroom**, non usato dall'avvio base. [OpenCodex](https://github.com/lidge-jun/opencodex) include il runtime Bun nella propria installazione npm; non serve un Bun globale separato per `ocx`. Runtime PHP/JDK e toolchain mobile non vengono aggiunti senza requisiti/versioni dei relativi progetti; PhpStorm non equivale a un runtime PHP locale.

## Fasi e opzioni

Gli esempi seguenti presuppongono che la policy della sessione consenta gli script; altrimenti usa il prefisso `powershell.exe ... -File` dell'avvio rapido (una fase per invocazione).

```powershell
# Solo app, poi Node + aih/OpenCodex/pxpipe/agentmemory; utile anche per aggiornare il vecchio restore.
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Apps
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Node
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase System

# Versioni esplicite: sostituire con le versioni che hai scelto e verificato.
.\Restore-Workstation.ps1 -Phase Node -NodeVersion 24.14.0 -AihVersion 1.2.4

# Esempio esclusioni (usare sempre gli ID WinGet del CSV).
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Apps -SkipPackage Valve.Steam,Discord.Discord -SkipWhatsApp

# Alternativa Chocolatey, preferibilmente su sistema pulito.
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Apps -PackageManager Chocolatey -BootstrapPackageManager

# WhatIf e' sicuro anche insieme ad Apply.
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -WhatIf
```

Il bootstrap Chocolatey e' opt-in: scarica `https://community.chocolatey.org/install.ps1` nel log e lo esegue. I pacchetti Chocolatey sono script community con privilegi amministrativi: rivedili prima dell'uso. Non c'e' fallback automatico dopo un'installazione fallita/parziale, nessun `--force`, `--pre` o bypass checksum. **Codex resta Store anche in modalita' Chocolatey**: se manca WinGet viene segnalato il link manuale, mai sostituito con la CLI `OpenAI.Codex`.

## Neden: ripristino dell'engine sorgenti

`Neden.vsconfig` e' la copia della configurazione del progetto: MSVC **14.44/17.14** e **14.38/17.8** con ATL, SDK **10.0.22621**, targeting pack .NET 4.6.2, Clang, workload C++/game/.NET/Linux e integrazione Unreal. L'engine locale preferisce MSVC 14.44 ed esclude diverse versioni intermedie; non viene forzato il compilatore globalmente in `BuildConfiguration.xml`. L'installer potrebbe non offrire piu' componenti legacy: vengono segnalati, non sostituiti silenziosamente.

Viene modificata in modo additivo un'installazione VS2022 Community/Professional/Enterprise esistente; se manca, viene scaricato il bootstrapper **2022 Community firmato Microsoft**. Non viene modificato VS2026. Non rimuove componenti o chiude forzatamente Visual Studio.

1. Ripristina lo snapshot engine **5.7.4** e il workspace Perforce con tutti i plugin. Configura server, login, client/root e mapping P4V; sincronizza dal client solo dopo aver salvaguardato le modifiche locali. Lo script non esegue sync/pull/checkout.
2. Installa toolchain e prepara il progetto:

```powershell
# Anche senza engine/workspace gia' ripristinati: solo VS/toolchain.
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Unreal -ToolchainOnly

# Dopo aver ripristinato i dati:
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Unreal

# Solo se mancano dipendenze del source engine: download + compilazione espliciti.
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Unreal -PrepareSource -BuildEditor

# Percorsi nuovi dopo la formattazione:
.\Restore-Workstation.ps1 -Apply -AcceptAgreements -Phase Unreal -WorkspacePath 'E:\Perforce\Neden_NiccoloWorkspace' -EnginePath 'D:\MMO\UE5.7'
```

La fase completa verifica `Build.version=5.7.4` e la GUID `{FB7517BB-46EF-B579-0D08-F8A6ECE6D25E}`, la registra in **HKCU** senza sovrascrivere associazioni divergenti, esegue i prerequisiti firmati dell'engine e genera i project files Neden per VS2022. Nello snapshot attuale e' presente `vc_redist.x64.exe` invece del bundle `UEPrereqSetup_x64.exe`: il fallback installa il runtime VC++, non pretende di sostituire ogni eventuale dipendenza di terzi. Non modifica `.uproject`, `.mcp.json`, configurazioni di rete/Steam o credenziali. La GUID da sola non garantisce di avere tutti i sorgenti/dipendenze: conserva lo snapshot originale.

`-PrepareSource` esegue **codice dal backup locale fidato** (`Setup.bat --force`, poi `GenerateProjectFiles.bat`). `--force` evita il prompt nascosto di GitDependencies, ma **puo' sostituire file di dipendenze modificati**: usare solo con backup verificato. Non serve su uno snapshot completo gia' funzionante. `-BuildEditor` compila ShaderCompileWorker e NedenEditor: operazione lunga, CPU/disco intensiva, con molto spazio libero richiesto. Senza questo switch non viene dichiarata verificata una build dell'editor.

### Plugin e passaggi manuali rilevati

- Conservare tutti i plugin del progetto, inclusi VibeUE, UnrealClaude, AdvancedSessions/AdvancedSteamSessions, SteamAPI, JourneyMinimap, SuperChat, UMGFileManager, VaRest. La compatibilita' non si deduce dal solo nome/versione: non scaricare automaticamente versioni nuove al loro posto.
- **UnrealClaude:** il bridge Node ha un lockfile, ma il `package.json` attuale contiene la dipendenza auto-riferita **`"ue5-mcp-server": "file:"`**. Per prudenza il restore segnala lavoro manuale e non esegue npm su quel manifest ambiguo. Correggere/verificare la dipendenza e il lockfile nel normale flusso Perforce, poi rieseguire; con un manifest valido usa `npm ci` (oppure `npm install` senza lockfile). Non modifica automaticamente i file del progetto.
- `.mcp.json` contiene percorsi assoluti: aggiornarli manualmente se cambia username/root. VibeUE usa `127.0.0.1:8088/mcp`; UnrealClaude usa il backend `localhost:3000`. Questi endpoint richiedono l'editor/plugin in esecuzione. Non vengono aperte porte pubbliche.
- Il progetto include plugin Steam e un target `NedenServer`, ma la configurazione condivisa imposta `DefaultPlatformService=NULL`: Steam/AppID e test multiplayer si configurano a parte. Il restore non scarica credenziali o SDK server/console, non compila il dedicated server.

## Verifica e log

Dopo il riavvio, apri un **nuovo terminale non amministrativo**, completa i login e verifica:

```powershell
git --version
nvm list
node --version
npm list -g @drakonkat/ai-helper @bitkyc08/opencodex pxpipe-proxy @agentmemory/agentmemory --depth=0
Get-Command aih,ocx,pxpipe,agentmemory
aih status
p4 -V
wsl --version
# Avvia prima Docker Desktop e attendi che il backend sia pronto:
docker version
```

Dopo aver configurato i provider/login, puoi avviare manualmente la configurazione base da un terminale **non amministrativo**:

```powershell
aih start
aih status
```

Questi comandi avviano i servizi e possono creare/aggiornare le loro configurazioni: non vengono eseguiti dal restore o dai test. `aih start pxpipe` e' invece l'avvio esplicito del servizio standalone. Il successo dell'installazione non certifica login, disponibilita' dei modelli o salute dei servizi.

Apri Neden e verifica una compilazione dell'editor e i plugin. Se `p4` non e' sul PATH, verifica `C:\Program Files\Perforce\p4.exe` e i componenti P4V installati. Non confondere un installer riuscito con il completamento del login o con la riuscita della build UE.

Log/report: `%LOCALAPPDATA%\WorkstationRestore\logs\<timestamp>` (oppure `-LogDirectory`). `report.json` distingue `Present`, `Installed`, `OK`, `Manual`, `Deferred`, `Reboot`, `Failed`; l'helper UE ha log separati per comando. Gli errori non vengono ignorati e non impediscono alle app indipendenti di essere tentate. Exit code: **0** fasi richieste completate, **1** errore, **2** lavoro manuale, **3010** reboot. Controlla sempre il report: un errore puo' coesistere con un reboot necessario.

Test inclusi: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Test-Restore.ps1`. **34 test superati sia su PowerShell 5.1 sia su PowerShell 7**, piu' parsing dei due script. Sono offline: anteprime, guardie, simulazioni dei package manager e piccoli processi/fixture innocui per verificare exit code e quoting. **Non e' stata eseguita una reinstallazione reale su Windows pulito**, ne' una build UE o alcuna installazione su questo PC durante la preparazione.

## Fonti verificate

- [Microsoft: WinGet, installazione e bootstrap](https://learn.microsoft.com/en-us/windows/package-manager/winget/), [opzioni install](https://learn.microsoft.com/en-us/windows/package-manager/winget/install), [catalogo manifest](https://github.com/microsoft/winget-pkgs).
- [OpenAI: download desktop Windows](https://learn.chatgpt.com/docs/windows/windows-app): ID Store `9PLM9XGG6VKS`; [Claude Desktop, manifest](https://github.com/microsoft/winget-pkgs/tree/master/manifests/a/Anthropic/Claude).
- [Epic: VS per UE5.7](https://dev.epicgames.com/documentation/en-us/unreal-engine/setting-up-visual-studio-development-environment-for-cplusplus-projects-in-unreal-engine?application_version=5.7), [Microsoft: bootstrapper/parametri VS2022](https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio?view=vs-2022), [componenti VS](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-community?view=vs-2022). Per Neden prevalgono `.vsconfig` e `Engine\Config\Windows\Windows_SDK.json` dello snapshot locale.
- [Docker Windows/WSL2](https://docs.docker.com/desktop/setup/install/windows-install/), [NVM: conflitti Node/PATH](https://github.com/coreybutler/nvm-windows/wiki/Common-Issues), [Perforce: P4V include P4 CLI su Windows](https://help.perforce.com/helix-core/server-apps/p4v/current/Content/P4V/install-p4v.html).
- [Teams unificato](https://blogs.windows.com/windowsexperience/2024/08/20/unified-teams-app-for-work-personal-and-education-accounts-now-available-on-windows/), [Chocolatey: catalogo](https://community.chocolatey.org/packages).
