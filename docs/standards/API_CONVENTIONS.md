# API Conventions & Design Guidelines

**Last Synced:** 2026-11-16  
**Protocol:** RESTful over HTTPS (JSON, 1 MB Router Payload Cap)  
**Base URL:** `https://api.brisksms.com/v1` (or tenant staging base URL)  
**Authentication:** HttpOnly Session Cookie + Double-Submit CSRF (`bsk_session`/`bsk_csrf`), User Bearer JWT, Scoped Developer API Key (`bsk_live_...`), OAuth 2.0 Bearer Token (`bsk_at_...`), or Hardware-Bound Device Token (`bsk_dev_...`)  

---

## 1. General Principles

1. **Resource-Oriented URLs:** Use plural nouns for resources (e.g., `/v1/payments`, `/v1/invoices`, `/v1/devices`). Avoid verbs in URI paths; rely on HTTP methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`).
2. **Versioning:** The major version is embedded in the URL path (`/v1`). Breaking changes require a new version path (`/v2`). Minor, non-breaking additive changes (adding optional fields) occur within the current version.
3. **JSON Everywhere:** All request bodies and response payloads must use `Content-Type: application/json`.
4. **Idempotency:** State-mutating operations (`POST`) must accept an `Idempotency-Key` header (UUIDv4) to safely retry network failures without duplicate processing.

---

## 2. Standard HTTP Methods

| Method | Usage | Expected Status on Success |
|---|---|---|
| `GET` | Retrieve a resource or list of resources. Safe and idempotent. | `200 OK` |
| `POST` | Create a new resource or execute a complex operation. | `201 Created` or `200 OK` |
| `PATCH` | Partially update an existing resource. | `200 OK` |
| `DELETE`| Remove or revoke a resource. | `200 OK` or `204 No Content` |

---

## 3. Standard Response Envelope

All API responses follow a consistent envelope structure:

### 3.1. Successful Single Resource Response:
```json
{
  "success": true,
  "data": {
    "id": "018f2d5e-4a1b-7890-a1b2-c3d4e5f6a7b8",
    "provider": "MPESA",
    "reference": "QA12BC34DE",
    "amount": 5000000,
    "currency": "TZS",
    "state": "VERIFIED",
    "createdAt": "2026-11-05T14:32:00.000Z"
  }
}
```

### 3.2. Successful Paginated List Response:
```json
{
  "success": true,
  "data": [ ... ],
  "meta": {
    "page": 1,
    "limit": 20,
    "totalItems": 154,
    "totalPages": 8,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

### 3.3. Standard Error Envelope:
```json
{
  "success": false,
  "error": {
    "code": "PAYMENT_NOT_FOUND",
    "message": "No payment found with the specified identifier within this organization.",
    "details": [
      {
        "field": "paymentId",
        "issue": "Invalid UUID format"
      }
    ],
    "requestId": "req_018f2d60_a1b2_c3d4",
    "timestamp": "2026-11-05T14:35:12.345Z"
  }
}
```

---

## 4. Standard Error Codes & HTTP Status Mapping

| HTTP Status | Error Code | Description |
|---|---|---|
| `400 Bad Request` | `VALIDATION_ERROR` / `INVALID_PAYLOAD` | Request payload failed validation or schema boundaries. |
| `401 Unauthorized` | `UNAUTHORIZED` / `TOKEN_REVOKED` / `INVALID_TOKEN` | Missing, expired, revoked, or invalid JWT, session cookie, OAuth token, or API key. |
| `403 Forbidden` | `FORBIDDEN` / `CROSS_ORGANIZATION_FORBIDDEN` / `CSRF_*` | Missing RBAC role, cross-tenant attempt, revoked device (`DEVICE_REVOKED`), CSRF mismatch, or insufficient scope (`INSUFFICIENT_SCOPE`). |
| `402 Payment Required` | `PAYMENT_VERIFICATION_REQUIRED` | Paid subscription checkout submitted without verified payment evidence. |
| `404 Not Found` | `NOT_FOUND` | Target route or resource does not exist in caller's organization. |
| `409 Conflict` | `DUPLICATE_PAYMENT` / `IDEMPOTENCY_*` | Duplicate transaction reference/hash, claim collision, key replacement, or idempotency parameter mismatch. |
| `422 Unprocessable` | `UNSUPPORTED_STK_PROVIDER` / `AMOUNT_MISMATCH` | Transaction violates domain, currency, or carrier availability rules. |
| `429 Too Many Requests` | `RATE_LIMIT_EXCEEDED` | Request quota exceeded on rate-limited endpoints. |
| `500 Server Error` | `INTERNAL_ERROR` | Unexpected server failure (internal stack details suppressed in `NODE_ENV=production`). |
| `503 Service Unavailable` | `DATABASE_UNAVAILABLE` / `REDIS_UNAVAILABLE` / `PROVIDER_DISPATCH_DISABLED` | Required dependency unavailable or carrier transport fail-closed. |

---

## 5. Pagination, Sorting, and Filtering Conventions

- **Query Parameters:**
  - `page`: 1-based index (default: `1`).
  - `limit`: Number of items per page (default: `20`, maximum: `100`).
  - `sortBy`: Field name to order by (default: `createdAt`).
  - `sortOrder`: `asc` or `desc` (default: `desc`).
  - Filter parameters are camelCase (e.g., `?state=VERIFIED&provider=MPESA&dateFrom=2026-11-01`).

---

## 6. Currency & Numeric Representation

To eliminate floating-point inaccuracies:
- **All monetary amounts are represented as integers in minor currency units (cents).**
  - E.g., `50,000.00 TZS` is represented as `5000000` (assuming 2 decimal minor units).
- Field names explicitly indicate units where appropriate (e.g., `amountCents` or `amount` paired with `currency`).

