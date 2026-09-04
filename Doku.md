# Doku: Umsetzung Punkt 1 (REST-Fassade spezifizieren)

Datum: 2026-09-04

## Ziel

Punkt 1 aus der Todo-Liste vollstaendig machen:
- API-Vertrag fuer die REST-Fassade festziehen.
- Endpunkte, Schemas, Fehlercodes, Idempotenz und Timeout klar dokumentieren.
- Status der Endpunkte transparent machen (implementiert vs. geplant).

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

### 2) REST-Fassade Codeflaeche auf den Vertragsumfang erweitert

Datei: src/rest/rest-facade.ts

Aenderungen:
- Neue Platzhalter-Routen mit expliziter 501-Antwort statt generischem 404:
  - GET /api/v1/screening/business-partner/{bpId}/history
  - POST /api/v1/screening/batch
  - GET /api/v1/exceptions/{bpId}
  - POST /api/v1/exceptions/{bpId}
- Einheitliche Not-Implemented-Antwort mit:
  - error.code und error.message
  - recovery-Hinweis auf die OpenAPI-Datei
  - contract.timeoutMs und contract.idempotencyHeader
- Verbesserte Payload-Fehlerbehandlung fuer bestehendes Screening-POST:
  - Ungueltiges JSON oder zu grosse Payload wird jetzt als 400 validation_error zurueckgegeben.

### 3) README aktualisiert

Datei: README.md

Aenderungen:
- REST-Abschnitt um API-Vertragsinfos ergaenzt:
  - Verweis auf docs/rest-facade-openapi.yaml
  - Timeout-Vertrag (30000ms)
  - Idempotency-Key Empfehlung
- Rollout-Statusliste ergaenzt:
  - implemented fuer bestehende Endpunkte
  - planned (501) fuer neue Vertragsendpunkte

## Ergebnis

Punkt 1 ist jetzt abgeschlossen:
- Die REST-Fassade hat einen formalen, versionierbaren API-Vertrag.
- Alle in der Planung genannten Endpunkte sind im Vertrag enthalten.
- Nicht implementierte Endpunkte sind im Runtime-Verhalten klar gekennzeichnet (501) statt implizit fehlend.
- Fehlercodes, Idempotenz und Timeout sind dokumentiert und konsistent auffindbar.

## Hinweise

- Die Endpunkte history, batch und exceptions sind aktuell absichtlich als planned markiert.
- Der naechste Schritt waere die fachliche Implementierung hinter diesen Routen (Audit-Historie, Batch-Orchestrierung, Exception-Store).
