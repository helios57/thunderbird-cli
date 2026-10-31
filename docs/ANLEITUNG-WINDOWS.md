# thunderbird-cli für Claude Code unter Windows

Damit kann Claude Code (CLI) auf alle Mails in Thunderbird zugreifen: suchen, lesen, Threads,
Anhänge, Entwürfe. Alles läuft lokal. Thunderbird bleibt die einzige Stelle mit Passwörtern
und Kontodaten.

```
Claude Code ──stdio──> MCP-Server ──HTTP+Token──> Bridge 127.0.0.1:7700
                                                    │  Zugriffsstufe (read/draft/organize/full)
                                                    └──WebSocket 127.0.0.1:7701──> Thunderbird-Add-on ──> deine Mails
```

## Voraussetzungen

- Thunderbird 128 oder neuer (geprüft mit 159)
- Node.js 20 oder neuer (`node -v`)
- Claude Code (`claude --version`)
- Dieses Repo in `C:\workspace\thunderbird`

Das Add-on ist nicht von Mozilla signiert (auch das Original nicht). Thunderbird erlaubt das
standardmässig (`xpinstall.signatures.required = false`), es lässt sich dauerhaft installieren.

## Installation

### 1. Setup-Skript ausführen

In PowerShell (ohne Administratorrechte):

```powershell
powershell -ExecutionPolicy Bypass -File C:\workspace\thunderbird\scripts\windows\setup.ps1
```

Das Skript

1. installiert die npm-Abhängigkeiten,
2. legt `%USERPROFILE%\.config\thunderbird-cli\config.json` an: zufälliges Bridge-Token und
   Zugriffsstufe `draft`. Die Datei ist nur für deinen Benutzer lesbar,
3. richtet die Aufgabe «thunderbird-cli bridge» in der Aufgabenplanung ein: Die Bridge startet
   bei jeder Anmeldung unsichtbar und bei einem Absturz nach einer Minute neu. Sie wird auch
   sofort gestartet,
4. trägt den MCP-Server in Claude Code ein (`claude mcp add --scope user thunderbird ...`) und
   kopiert die Skill nach `%USERPROFILE%\.claude\skills\thunderbird-cli`,
5. baut das Add-on: `C:\workspace\thunderbird\dist\thunderbird-cli-2.1.1.5.xpi`.

Erneut ausführen ist unbedenklich. Das Token bleibt, die Stufe wird übernommen, die Bridge neu
gestartet.

### 2. Add-on in Thunderbird installieren (einmalig)

1. Thunderbird → Menü → **Add-ons und Themes** (`Ctrl+Shift+A`)
2. Zahnrad oben → **Add-on aus Datei installieren…**
3. `C:\workspace\thunderbird\dist\thunderbird-cli-2.1.1.5.xpi` wählen
4. Die Berechtigungen (Konten und Nachrichten lesen, verfassen, verschieben …) bestätigen

Das Add-on verbindet sich innerhalb von höchstens 15 Sekunden mit der Bridge.

### 3. Prüfen

```powershell
node C:\workspace\thunderbird\cli\src\cli.js health
node C:\workspace\thunderbird\cli\src\cli.js stats
```

`health` muss `"status":"ok"` liefern, `stats` deine Konten mit Zahlen.

### 4. Claude Code neu starten

Eine neue Claude-Code-Sitzung starten. `/mcp` zeigt `thunderbird` als verbunden. Dann zum
Beispiel fragen: «Welche Mails sind heute gekommen?» oder «Such die letzte Rechnung von
Swisscom und lies das PDF».

## Zugriffsstufen

Die Bridge entscheidet, was erlaubt ist, nicht das Modell. Das ist wichtig, weil Claude Code
im Bypass-Modus vor einem Tool-Aufruf nicht nachfragt.

| Stufe | Erlaubt | Nicht erlaubt |
|---|---|---|
| `read` | suchen, lesen, Threads, Anhänge, Statistik, Kontakte | jede Änderung |
| `draft` (Standard) | dazu: Entwürfe erstellen, Antwort/Weiterleitung als Entwurf oder im Fenster öffnen | senden, löschen, verschieben, markieren |
| `organize` | dazu: gelesen/markiert/Junk setzen, Tags, verschieben, archivieren, Ordner anlegen/umbenennen | senden, löschen |
| `full` | alles, auch sofort senden und löschen | – |

Stufe wechseln:

```powershell
powershell -ExecutionPolicy Bypass -File C:\workspace\thunderbird\scripts\windows\setup.ps1 -Policy organize
```

Abgelehnte Aufrufe enden mit `POLICY_DENIED` und erreichen Thunderbird nie.

## Tipps für grosse Postfächer

- **Neueste zuerst:** `email_search` und `email_recent` liefern die neuesten Treffer über alle
  Konten. Intern wird rückwärts in Zeitfenstern gesucht (7 Tage, 60 Tage, 1 Jahr, Rest), ohne
  den ganzen Bestand zu laden.
- **Textsuche eingrenzen:** Thunderbird hat für diese Suche keinen Index. Bei einer Textsuche
  wird der Inhalt jeder Mail im aktuellen Zeitfenster geparst. Mit Zeitraum (`since`), Konto
  oder Ordner ist sie schnell, ohne Eingrenzung über Jahre kann sie dauern.
- **Gross-/Kleinschreibung zählt:** «rechnung» findet «Rechnung» nicht.
- **IMAP-Konten offline halten:** Für Volltextsuche und schnelles Lesen sollten die Mails
  lokal liegen: Konten-Einstellungen → *Synchronisation & Speicherplatz* → *Nachrichten für
  dieses Konto auf diesem Computer bereithalten*. Sonst muss Thunderbird jede Mail erst vom
  Server holen.
- **Anhänge** landen in `%TEMP%\thunderbird-cli\attachments`; Claude bekommt nur den Pfad und
  kann PDFs und Bilder von dort lesen.

## Betrieb

| | |
|---|---|
| Bridge-Log | `%LOCALAPPDATA%\thunderbird-cli\bridge.log` (Fehler: `bridge.err.log`) |
| Bridge-Status | `node C:\workspace\thunderbird\cli\src\cli.js bridge-status` |
| Bridge neu starten | `Stop-ScheduledTask "thunderbird-cli bridge"; Start-ScheduledTask "thunderbird-cli bridge"` |
| Konfiguration | `%USERPROFILE%\.config\thunderbird-cli\config.json` |

Thunderbird muss laufen, damit Claude Mails sieht. Die Bridge läuft immer.

**Aktualisieren:** `git pull` im Repo, dann `setup.ps1` erneut. Hat sich das Add-on geändert
(neue Version in `extension/manifest.json`), das neue `.xpi` wie oben installieren.

**Entfernen:**

```powershell
powershell -ExecutionPolicy Bypass -File C:\workspace\thunderbird\scripts\windows\uninstall.ps1
```

Danach das Add-on in Thunderbird entfernen.

## Sicherheit

- **Daten an Anthropic:** Was Claude liest, geht als Kontext an die Claude-API. Das ist der
  Zweck des Ganzen, gilt aber auch für Arzt-, Steuer- und Bankmails.
- **Prompt-Injection:** Mails können Anweisungen an eine KI enthalten. Die Stufe `draft`
  begrenzt den möglichen Schaden: kein Senden, kein Löschen.
- **Lokaler Zugriff:** Die Bridge lauscht nur auf `127.0.0.1` und verlangt das Token. Anfragen
  aus Webseiten im Browser werden abgewiesen.
- **Restrisiko:** Das Add-on prüft nicht, mit wem es spricht. Läuft die Bridge nicht, könnte
  ein anderes lokales Programm Port 7701 belegen und Befehle schicken. Darum startet die Bridge
  automatisch und hält den Port. Programme mit deinen Benutzerrechten könnten allerdings auch
  so dein Thunderbird-Profil lesen.

## Fehlerbehebung

| Meldung | Ursache und Lösung |
|---|---|
| `BRIDGE_UNREACHABLE` | Bridge läuft nicht: `Start-ScheduledTask "thunderbird-cli bridge"`, sonst `bridge.err.log` lesen |
| `EXTENSION_DISCONNECTED` | Thunderbird läuft nicht oder das Add-on ist deaktiviert; nach dem Start bis zu 15 s warten |
| `AUTH_REQUIRED` | Token passt nicht: Bridge nach Änderungen an `config.json` neu starten |
| `POLICY_DENIED` | Aktion braucht eine höhere Stufe, siehe oben |
| `partial: true` | Zeitlimit erreicht: alles neuer als `searchedBackTo` ist durchsucht, ältere Mails nicht. Mit `until` weitersuchen oder eingrenzen |
| `TIMEOUT` | Suche zu breit: Zeitraum, Konto oder Ordner angeben. Ergebnis ist unbekannt, nicht leer |
| Port belegt | `Get-NetTCPConnection -LocalPort 7700,7701 \| Select-Object LocalPort, OwningProcess` |
