# API Conventions & Design Guidelines

**Protocol:** RESTful over HTTPS (JSON)  
**Base URL:** `https://api.brisksms.co.tz/v1`  
**Authentication:** Bearer Token (JWT) / API Key (`bsk_live_...` or `bsk_test_...`)  

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
| `400 Bad Request` | `VALIDATION_FAILED` | Request payload failed schema validation (Zod / Class-Validator). |
| `401 Unauthorized` | `UNAUTHENTICATED` | Missing, expired, or invalid JWT / API key. |
| `403 Forbidden` | `PERMISSION_DENIED` | Authenticated caller lacks required role or organization scope. |
| `404 Not Found` | `RESOURCE_NOT_FOUND` | Target resource does not exist in the caller's organization. |
| `409 Conflict` | `DUPLICATE_RESOURCE` | Resource with identical unique key/reference already exists. |
| `422 Unprocessable` | `FINANCIAL_RULE_VIOLATION` | Transaction fails domain rule (e.g., trying to settle already paid invoice). |
| `429 Too Many Requests` | `RATE_LIMIT_EXCEEDED` | Request quota exceeded for IP or API key. Includes `Retry-After` header. |
| `500 Server Error` | `INTERNAL_ERROR` | Unexpected server failure. Tracked in Sentry with `requestId`. |

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
