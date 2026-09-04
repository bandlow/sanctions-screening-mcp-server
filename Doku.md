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
