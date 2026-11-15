# API conventions

Frozen by design 0001 §9 (contract 0.1.0). This page is the working reference for every lane that exposes or calls an HTTP endpoint. If it ever disagrees with the design, the design wins and this page is fixed.

## Versioning

- REST + JSON under `/api/v1`.
- A breaking change ships as `/api/v2`. `/api/v1` stays until every supported app version (at or above `min_app_version`) uses v2, and for at least 90 days.
- Adding an optional response field is not breaking. Clients ignore unknown fields.

## Staff endpoints

- `Authorization: Bearer <Supabase JWT>` with `aal2`.
- The API checks the permission (for example `core.content.publish`) and RLS enforces it again in the database. Never rely on only one of them.
- Each request runs as `api_rt` with the caller's claims set for that transaction only.

## Public writes (contact, report, request forms)

No JWT. These endpoints receive personal data from people who are not staff, so they say as little as possible.

| Rule | Value |
| --- | --- |
| Response | always `202 { "receipt_id": "<uuid>" }`; never echoes the submission; never reveals whether a person or case already exists |
| `Idempotency-Key` | required, UUID, scoped to the endpoint |
| Idempotency store | `core.idempotency` keeps `sha256(endpoint\|key)`, `sha256(body)`, status and `receipt_id`; rows deleted after 24 h |
| Replay | same body returns the same receipt; a different body returns `409` |
| Client IP | only the hosting platform's trusted client-IP header; IPv4 full address, IPv6 truncated to /64 |
| Rate-limit key | `HMAC(daily_key, canonical IP or prefix)`; counters live 1 h; daily keys destroyed after 48 h; raw IPs never stored |
| Quotas | per key and endpoint, global per endpoint, and on concurrency |
| Body | at most 16 KB; attachments belong to the module, are quarantined and scanned before staff can open them |
| Challenge | above a threshold, a privacy-preserving challenge without tracking cookies |

## Errors

RFC 9457 `application/problem+json`. `type` is `urn:mandato:error:<code>`, `title` is in pt-BR, field errors go in `errors[] { field, code, message }`. Never put personal data in an error.

```json
{
  "type": "urn:mandato:error:validation",
  "title": "Alguns campos precisam de correção.",
  "status": 422,
  "errors": [{ "field": "municipality_ibge", "code": "pattern", "message": "Informe o código IBGE com 7 dígitos." }]
}
```

## Pagination

Cursor over `(sort key, id)`, opaque base64. Request `?cursor=&limit=` (max 100). Response `{ "data": [ … ], "next_cursor": "…" }`, with `next_cursor` null on the last page. Clients never build or parse a cursor.

## Values

| Kind | Format |
| --- | --- |
| Instant | ISO 8601 with offset, e.g. `2026-11-05T10:00:00-03:00` |
| Date | `YYYY-MM-DD` |
| Period | `{ "start": "2026-01-01", "end": "2026-12-31" }`, both inclusive |
| Money | integer centavos with `"currency": "BRL"` |
| Municipality | IBGE code, 7 digits, as a string |
| Number shown to citizens | carries `source_id`, `source_url`, `reference_date` |

## Citizen read path

The citizen app does not read through `/api`. It syncs the signed static publication (design 0001 §6.3): `manifest.json` plus content-addressed bundles. `tenants/demo/published/` is a working example, built by `scripts/publish-demo.sh` from `tenants/demo/seed.sql` and checked by `tests/demo-published.test.js`.
