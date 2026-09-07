# Doku: Umsetzung Punkt 1 und 2 (REST-Fassade)

Datum: 2026-09-04

## Ziel

Punkt 1 und 2 aus der Todo-Liste vollstaendig machen:
- API-Vertrag fuer die REST-Fassade festziehen.
- Endpunkte, Schemas, Fehlercodes, Idempotenz und Timeout klar dokumentieren.
- REST-Fassade im Server vollstaendig verdrahten und die benoetigten Endpunkte funktional bereitstellen.

## Durchgefuehrte Aenderungen

### 1) Formale OpenAPI-Spezifikation angelegt

Datei: docs/rest-facade-openapi.yaml

Inhalt:
- OpenAPI 3.1 Dokument fuer die REST-Fassade.
- Enthaltene Endpunkte:
  - GET /api/v1/sources
  - POST /api/v1/screening/business-partner
  - GET /api/v1/screening/business-partner/{bpId}/history
  - POST /api/v1/screening/batch
  - GET /api/v1/exceptions/{bpId}
  - POST /api/v1/exceptions/{bpId}
- Request/Response-Schemas fuer alle Endpunkte inkl. Fehlerobjekten.
- Idempotenz-Hinweis fuer POST-Routen per Header Idempotency-Key.
- Timeout-Vertrag als x-timeout-ms: 30000.
- Implementierungsstatus je Operation via x-implementation-status:
  - implemented fuer bestehende Routen.
  - planned fuer noch nicht gebaute Routen.

### 2) REST-Fassade im Server funktional implementiert

Datei: src/rest/rest-facade.ts

Aenderungen:
- Neue Endpunkte jetzt fachlich umgesetzt (statt 501-Platzhalter):
  - GET /api/v1/screening/business-partner/{bpId}/history
  - POST /api/v1/screening/batch
  - GET /api/v1/exceptions/{bpId}
  - POST /api/v1/exceptions/{bpId}
- Screening-Logik zentralisiert:
  - Gemeinsame Execute-Funktion fuer Single- und Batch-Screening.
  - Konsistente Antwortstruktur (Treffer als Kandidaten + Caveat).
  - Quellenstand (`sourcesAsOf`) wird in Screening-Antwort aufgenommen.
- History-Tracking eingefuehrt:
  - In-Process Event-Store pro BP (`historyByBpId`).
  - Jeder Screening-Lauf mit `bpId` erzeugt ein History-Event.
  - History-Endpoint mit Pagination (`limit`, `offset`).
- Batch-Verarbeitung umgesetzt:
  - Endpoint akzeptiert mehrere BP-Eintraege.
  - Verarbeitet aktuell sofort in-process und schreibt je BP History-Ereignisse.
  - Rueckgabe mit `202 accepted` inkl. Zaehlern (accepted/processed/failed).
- Exception-Verwaltung umgesetzt:
  - In-Process Store pro BP (`exceptionsByBpId`).
  - POST legt Exceptions mit UUID an, GET listet pro BP.
- Verbesserte Payload-Fehlerbehandlung:
  - Ungueltiges JSON oder zu grosse Payload liefert 400 validation_error.
- REST-CORS/Headers erweitert:
  - `Idempotency-Key` als erlaubter Header.
  - `X-Rest-Timeout-Ms` wird in Antworten gesetzt.

### 3) README aktualisiert

Datei: README.md

Aenderungen:
- REST-Abschnitt um API-Vertragsinfos ergaenzt:
  - Verweis auf docs/rest-facade-openapi.yaml
  - Timeout-Vertrag (30000ms)
  - Idempotency-Key Empfehlung
- Rollout-Statusliste aktualisiert:
  - Alle sechs Endpunkte als implemented.

## Ergebnis

Punkt 1 und 2 sind jetzt abgeschlossen:
- Die REST-Fassade hat einen formalen, versionierbaren API-Vertrag.
- Alle in der Planung genannten Endpunkte sind im Vertrag enthalten.
- Alle Endpunkte sind im Runtime-Verhalten erreichbar und nicht mehr nur als Platzhalter vorhanden.
- Fehlercodes, Idempotenz und Timeout sind dokumentiert und konsistent auffindbar.
- Screening-Ausgaben bleiben entscheidungsoffen (Caveat bleibt Bestandteil jeder Screening-Antwort).

## Hinweise

- History/Batch/Exceptions sind aktuell bewusst als In-Process-Implementierung umgesetzt.
- Fuer produktiven Betrieb sollte der Zustand spaeter in die geplante CAP/HANA-Audit-Schicht verlagert werden.
- Die OpenAPI-Datei spiegelt den aktuellen Ist-Stand (implemented) wider.

---

# Doku: Umsetzung Punkt 3 (Fiori-App fuer Compliance-Fallbearbeitung, MVP)

Datum: 2026-09-04

## Ziel

Punkt 3 aus der Umsetzungsreihenfolge realisieren:
- Eine bedienbare Compliance-Fallbearbeitungsoberflaeche bereitstellen.
- Die benoetigten Case-APIs im REST-Layer funktional auspraegen.
- Entscheidungsfluss inkl. optionalem Vier-Augen-Feld modellieren.

## Durchgefuehrte Aenderungen

### 1) Compliance-Case-Backend in der REST-Fassade ergaenzt

Datei: src/rest/rest-facade.ts

Aenderungen:
- Neue REST-Endpunkte fachlich umgesetzt:
  - GET /api/v1/compliance/cases
  - GET /api/v1/compliance/cases/{caseId}
  - POST /api/v1/compliance/cases/{caseId}/decision
- In-Process Case-Store eingefuehrt:
  - `complianceCasesById` fuer Case-Daten.
  - `complianceCaseIdsByBpId` fuer BP->Case-Zuordnung.
- Case-Erzeugung automatisiert:
  - Bei Screening mit `bpId` und Treffern wird automatisch ein Case erzeugt/aktualisiert.
  - Treffer werden als Case-Hits mit `reviewStatus` uebernommen.
- Entscheidungsfluss umgesetzt:
  - Decision-API akzeptiert `confirmed_match`, `false_positive`, `escalate`.
  - Optionales `approvedBy` unterstuetzt Vier-Augen-Freigabe.
  - Guardrail: `approvedBy` darf nicht gleich `proposedBy` sein.

### 2) Fiori-nahe Worklist-UI bereitgestellt

Datei: src/rest/rest-facade.ts

Aenderungen:
- Neue UI-Route umgesetzt:
  - GET /ui/compliance-cases
- Enthaltene Funktionen der UI:
  - Case-Worklist mit Status-Filter.
  - Case-Detailansicht mit Hits und bisherigen Entscheidungen.
  - Decision-Erfassung direkt aus der UI.
- Die UI nutzt ausschliesslich die neuen REST-Case-Endpunkte.

### 3) API-Vertrag und README aktualisiert

Dateien:
- docs/rest-facade-openapi.yaml
- README.md

Aenderungen:
- OpenAPI um Compliance-Case-Paths und Schemas erweitert.
- README-Rolloutliste um die drei Case-Endpunkte erweitert.
- README um den neuen UI-Einstiegspunkt `/ui/compliance-cases` ergaenzt.

## Ergebnis

Punkt 3 ist als MVP umgesetzt und dokumentiert:
- Es gibt eine lauffaehige Fallbearbeitungsoberflaeche fuer Compliance-Cases.
- Der zugehoerige REST-Vertrag ist formal beschrieben.
- Cases werden automatisch aus Screening-Treffern erzeugt und koennen manuell entschieden werden.

## Hinweise

- Der Case-/Decision-Zustand ist aktuell bewusst In-Process (kein persistenter Speicher).
- Fuer produktiven Betrieb ist die Verlagerung in die geplante CAP/HANA-Schicht weiterhin vorgesehen.
- Die Screening-Caveat-Logik bleibt unveraendert: Treffer sind Kandidaten zur Verifikation, keine automatische Entscheidung.

---

# Doku: Umsetzung Punkt 4 (SAP-Integrationsmuster)

Datum: 2026-09-07

## Ziel

Punkt 4 aus der Umsetzungsreihenfolge realisieren:
- Technische Eingangskanaele fuer SAP-ECC- und SAP-S/4HANA-Trigger bereitstellen.
- SAP-spezifische Payloads auf den bestehenden Screening-Kern mappen (ohne doppelte Fachlogik).
- Integration formal im OpenAPI-Vertrag dokumentieren.

## Durchgefuehrte Aenderungen

### 1) SAP-Adapter-Endpunkte in der REST-Fassade implementiert

Datei: src/rest/rest-facade.ts

Aenderungen:
- Neue Endpunkte umgesetzt:
  - POST /api/v1/integration/sap/ecc/business-partner-changed
  - POST /api/v1/integration/sap/s4/business-partner-changed
  - POST /api/v1/integration/sap/batch-business-partners
- Fachliches Verhalten:
  - ECC- und S/4-Realtime-Payloads werden auf das bestehende Business-Partner-Screening gemappt.
  - Batch-Payloads werden eintragsweise verarbeitet und liefern Zaehler + Fehlerliste zurueck.
  - Treffer bleiben strikt als Kandidaten zur Verifikation (Caveat unveraendert).
- Konsistenz im Nebenverhalten:
  - Erfolgreiche SAP-Screenings schreiben wie die bestehenden REST-Routen in History.
  - Bei Treffern wird die vorhandene Case-Erzeugungslogik wiederverwendet.
  - Side-Effects wurden in eine gemeinsame Hilfsfunktion zusammengefuehrt, um Unterschiede zwischen Endpunkten zu vermeiden.

### 2) OpenAPI-Vertrag erweitert

Datei: docs/rest-facade-openapi.yaml

Aenderungen:
- Neue Pfade inkl. Request-/Response-Schemas fuer SAP-Integration hinzugefuegt.
- Neuer Tag `SapIntegration` fuer klare Gruppierung.
- Implementierungsstatus fuer alle neuen SAP-Operationen auf `implemented` gesetzt.

### 3) README aktualisiert

Datei: README.md

Aenderungen:
- Rollout-Status um die drei SAP-Adapter-Endpunkte erweitert.
- Beispielaufrufe fuer ECC-Realtime, S/4-Realtime und SAP-Batch hinzugefuegt.

### 4) Testabdeckung erweitert

Datei: tests/rest/rest-facade.test.ts

Aenderungen:
- Zuschnitt auf die neuen SAP-Adapter-Endpunkte ergaenzt.
- Verifiziert werden:
  - Realtime-Aufrufpfad fuer ECC inkl. Screening-Antwort.
  - Realtime-Aufrufpfad fuer S/4 inkl. Screening-Antwort.
  - Batch-Aufrufpfad inkl. `202 accepted` und Zaehlerfeldern.

## Ergebnis

Punkt 4 ist im aktuellen Serverstand umgesetzt:
- SAP-spezifische Eingangspayloads koennen direkt an dedizierte Integrationsendpunkte gesendet werden.
- Die Verarbeitung nutzt weiterhin den bestehenden Screening-Kern und bleibt damit konsistent zur restlichen REST-Fassade.
- Die Integrationsschnittstelle ist im OpenAPI-Vertrag formal beschrieben und im README mit Beispielaufrufen dokumentiert.

## Hinweise

- Die neuen SAP-Adapter sind bewusst als In-Process-Implementierung ausgepraegt (identisch zum aktuellen REST-MVP-Charakter).
- Entsprechend dem Zielbild bleibt fuer produktiven Compliance-Betrieb die persistente CAP/HANA-Schicht fuer Audit/Fallbearbeitung weiterhin erforderlich.
