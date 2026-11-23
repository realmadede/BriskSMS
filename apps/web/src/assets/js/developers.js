// 1. API Playground Data
const endpointsData = {
  stk_push: {
    curl: `curl -X POST https://api.brisksms.app/v1/payments/stk-push \\
  -H "x-api-key: YOUR_BRISKSMS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "phoneNumber": "0754123456",
    "amount": 50000,
    "invoiceId": "inv_8829104",
    "referenceNumber": "INV-2026-004",
    "memo": "Annual Subscription"
  }'`,
    node: `const res = await fetch("https://api.brisksms.app/v1/payments/stk-push", {
  method: "POST",
  headers: {
    "x-api-key": process.env.BRISKSMS_API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    phoneNumber: "0754123456",
    amount: 50000,
    invoiceId: "inv_8829104",
    referenceNumber: "INV-2026-004",
    memo: "Annual Subscription"
  })
});
const { data } = await res.json();
console.log("Checkout ID:", data.checkoutId);`,
    ts: `const res = await fetch("https://api.brisksms.app/v1/payments/stk-push", {
  method: "POST",
  headers: {
    "x-api-key": process.env.BRISKSMS_API_KEY!,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    phoneNumber: "0754123456",
    amount: 50000,
    invoiceId: "inv_8829104",
    referenceNumber: "INV-2026-004",
    memo: "Annual Subscription"
  })
});`,
    python: `import os, requests

response = requests.post(
    "https://api.brisksms.app/v1/payments/stk-push",
    headers={"x-api-key": os.environ["BRISKSMS_API_KEY"]},
    json={
        "phoneNumber": "0754123456",
        "amount": 50000,
        "invoiceId": "inv_8829104",
        "referenceNumber": "INV-2026-004",
        "memo": "Annual Subscription"
    },
    timeout=15
)`,
    go: `req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.brisksms.app/v1/payments/stk-push", body)
req.Header.Set("x-api-key", os.Getenv("BRISKSMS_API_KEY"))
req.Header.Set("Content-Type", "application/json")
resp, err := httpClient.Do(req)`,
    php: `$response = Http::withHeaders([
    'x-api-key' => env('BRISKSMS_API_KEY')
])->post('https://api.brisksms.app/v1/payments/stk-push', [
    'phoneNumber'     => '0754123456',
    'amount'          => 50000,
    'invoiceId'       => 'inv_8829104',
    'referenceNumber' => 'INV-2026-004',
    'memo'            => 'Annual Subscription'
]);`,
    java: `HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("https://api.brisksms.app/v1/payments/stk-push"))
    .header("x-api-key", System.getenv("BRISKSMS_API_KEY"))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
    .build();`,
    csharp: `httpClient.DefaultRequestHeaders.Add("x-api-key", Environment.GetEnvironmentVariable("BRISKSMS_API_KEY"));
var response = await httpClient.PostAsJsonAsync("https://api.brisksms.app/v1/payments/stk-push", new {
    phoneNumber = "0754123456",
    amount = 50000,
    invoiceId = "inv_8829104",
    referenceNumber = "INV-2026-004",
    memo = "Annual Subscription"
});`,
    response: `{
  "success": true,
  "data": {
    "checkoutId": "stk_88f912a7bc40e192",
    "organizationId": "org_c9401ab88",
    "provider": "MPESA",
    "phoneNumber": "255754123456",
    "amountCents": "5000000",
    "currency": "TZS",
    "status": "PENDING",
    "invoiceId": "inv_8829104",
    "referenceNumber": "INV-2026-004",
    "customerPrompt": "Tafadhali weka PIN yako ya M-Pesa kwenye simu yako kuthibitisha malipo ya TZS 50,000.",
    "initiatedAt": "2026-11-10T12:00:00.000Z"
  }
}`
  },
  ingest: {
    curl: `curl -X POST https://api.brisksms.app/v1/ingestion/evidence \\
  -H "Authorization: Bearer YOUR_DEVICE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "senderAddress": "M-PESA",
    "rawPayload": "09B8291M Confirmed. Tsh 150,000 received from AMANI MTEMI 255754000111 on 05/11/2026 14:22. Ref: INV-8829",
    "simSlot": 1,
    "deviceTimestamp": "2026-11-05T14:22:18Z"
  }'`,
    node: `const res = await fetch("https://api.brisksms.app/v1/ingestion/evidence", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${process.env.BRISKSMS_DEVICE_TOKEN}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    senderAddress: "M-PESA",
    rawPayload: "09B8291M Confirmed. Tsh 150,000 received from AMANI MTEMI 255754000111 on 05/11/2026 14:22. Ref: INV-8829",
    simSlot: 1,
    deviceTimestamp: new Date().toISOString()
  })
});
const { data } = await res.json();
console.log("Evidence ID:", data.evidenceId, "Hash:", data.deduplicationHash);`,
    ts: `const res = await fetch("https://api.brisksms.app/v1/ingestion/evidence", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${process.env.BRISKSMS_DEVICE_TOKEN!}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    senderAddress: "M-PESA",
    rawPayload: "09B8291M Confirmed. Tsh 150,000 received from AMANI MTEMI...",
    simSlot: 1,
    deviceTimestamp: new Date().toISOString()
  })
});`,
    python: `import os, requests

response = requests.post(
    "https://api.brisksms.app/v1/ingestion/evidence",
    headers={"Authorization": f"Bearer {os.environ['BRISKSMS_DEVICE_TOKEN']}"},
    json={
        "senderAddress": "M-PESA",
        "rawPayload": "09B8291M Confirmed. Tsh 150,000 received...",
        "simSlot": 1,
        "deviceTimestamp": "2026-11-05T14:22:18Z"
    },
    timeout=15
)`,
    go: `req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.brisksms.app/v1/ingestion/evidence", body)
req.Header.Set("Authorization", "Bearer "+deviceToken)
req.Header.Set("Content-Type", "application/json")
resp, err := httpClient.Do(req)`,
    php: `$response = Http::withToken(getenv('BRISKSMS_DEVICE_TOKEN'))
    ->post('https://api.brisksms.app/v1/ingestion/evidence', [
        'senderAddress'   => 'M-PESA',
        'rawPayload'      => '09B8291M Confirmed. Tsh 150,000 received from AMANI MTEMI...',
        'simSlot'         => 1,
        'deviceTimestamp' => date(DATE_ATOM)
    ]);`,
    java: `HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("https://api.brisksms.app/v1/ingestion/evidence"))
    .header("Authorization", "Bearer " + System.getenv("BRISKSMS_DEVICE_TOKEN"))
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
    .build();`,
    csharp: `httpClient.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("BRISKSMS_DEVICE_TOKEN"));
var ack = await httpClient.PostAsJsonAsync("https://api.brisksms.app/v1/ingestion/evidence", new {
    senderAddress = "M-PESA",
    rawPayload = "09B8291M Confirmed. Tsh 150,000 received from AMANI MTEMI...",
    simSlot = 1,
    deviceTimestamp = DateTime.UtcNow
});`,
    response: `{
  "success": true,
  "data": {
    "acknowledged": true,
    "status": "OBSERVED",
    "evidenceId": "evi_984920194829",
    "deduplicationHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
}`
  },
  verify: {
    curl: `curl -X POST https://api.brisksms.app/v1/reconciliation/verify \\
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "organizationId": "org_c9401ab88",
    "paymentId": "pay_984920194829",
    "invoiceId": "inv_8829",
    "verificationMethod": "MANUAL_FINANCE_APPROVAL",
    "notes": "Verified against bank settlement record"
  }'`,
    node: `const res = await fetch("https://api.brisksms.app/v1/reconciliation/verify", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${sessionToken}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    organizationId: "org_c9401ab88",
    paymentId: "pay_984920194829",
    invoiceId: "inv_8829",
    verificationMethod: "MANUAL_FINANCE_APPROVAL",
    notes: "Verified against bank settlement record"
  })
});`,
    ts: `const res = await fetch("https://api.brisksms.app/v1/reconciliation/verify", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${sessionToken}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    organizationId: "org_c9401ab88",
    paymentId: "pay_984920194829",
    invoiceId: "inv_8829",
    verificationMethod: "MANUAL_FINANCE_APPROVAL"
  })
});`,
    python: `response = requests.post(
    "https://api.brisksms.app/v1/reconciliation/verify",
    headers={"Authorization": f"Bearer {session_token}"},
    json={
        "organizationId": "org_c9401ab88",
        "paymentId": "pay_984920194829",
        "invoiceId": "inv_8829",
        "verificationMethod": "MANUAL_FINANCE_APPROVAL"
    },
    timeout=15
)`,
    go: `req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.brisksms.app/v1/reconciliation/verify", body)
req.Header.Set("Authorization", "Bearer "+sessionToken)
req.Header.Set("Content-Type", "application/json")
resp, err := httpClient.Do(req)`,
    php: `$response = Http::withToken($sessionToken)
    ->post('https://api.brisksms.app/v1/reconciliation/verify', [
        'organizationId'     => 'org_c9401ab88',
        'paymentId'          => 'pay_984920194829',
        'invoiceId'          => 'inv_8829',
        'verificationMethod' => 'MANUAL_FINANCE_APPROVAL'
    ]);`,
    java: `HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("https://api.brisksms.app/v1/reconciliation/verify"))
    .header("Authorization", "Bearer " + sessionToken)
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
    .build();`,
    csharp: `httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", sessionToken);
var result = await httpClient.PostAsJsonAsync("https://api.brisksms.app/v1/reconciliation/verify", new {
    organizationId = "org_c9401ab88",
    paymentId = "pay_984920194829",
    invoiceId = "inv_8829",
    verificationMethod = "MANUAL_FINANCE_APPROVAL"
});`,
    response: `{
  "success": true,
  "data": {
    "paymentId": "pay_984920194829",
    "status": "VERIFIED",
    "settlementResult": "EXACT_SETTLEMENT",
    "invoiceId": "inv_8829",
    "remainingBalanceMinor": 0
  }
}`
  },
  send: {
    curl: `curl -X POST https://api.brisksms.app/v1/messages/send \\
  -H "x-api-key: YOUR_BRISKSMS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "recipientPhone": "+255754000111",
    "message": "Habari Juma! Invoice #INV-2026-44 is confirmed. Karibu sana!",
    "simSlot": 1
  }'`,
    node: `const res = await fetch("https://api.brisksms.app/v1/messages/send", {
  method: "POST",
  headers: {
    "x-api-key": process.env.BRISKSMS_API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    recipientPhone: "+255754000111",
    message: "Habari Juma! Invoice #INV-2026-44 is confirmed. Karibu sana!",
    simSlot: 1
  })
});
const { data } = await res.json();
console.log("Message queued:", data.messageId);`,
    ts: `const res = await fetch("https://api.brisksms.app/v1/messages/send", {
  method: "POST",
  headers: {
    "x-api-key": process.env.BRISKSMS_API_KEY!,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    recipientPhone: "+255754000111",
    message: "Habari Juma! Invoice #INV-2026-44 is confirmed. Karibu sana!",
    simSlot: 1
  })
});`,
    python: `import requests, os

response = requests.post(
    "https://api.brisksms.app/v1/messages/send",
    headers={"x-api-key": os.getenv("BRISKSMS_API_KEY")},
    json={
        "recipientPhone": "+255754000111",
        "message": "Habari Juma! Invoice #INV-2026-44 is confirmed. Karibu sana!",
        "simSlot": 1
    }
)
print("Status:", response.json())`,
    go: `req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.brisksms.app/v1/messages/send", body)
req.Header.Set("x-api-key", apiKey)
req.Header.Set("Content-Type", "application/json")
resp, _ := httpClient.Do(req)`,
    php: `$response = Http::withHeaders(['x-api-key' => getenv('BRISKSMS_API_KEY')])
    ->post('https://api.brisksms.app/v1/messages/send', [
        'recipientPhone' => '+255754000111',
        'message'        => 'Habari Juma! Invoice #INV-2026-44 is confirmed. Karibu sana!',
        'simSlot'        => 1
    ]);`,
    java: `HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("https://api.brisksms.app/v1/messages/send"))
    .header("x-api-key", apiKey)
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
    .build();`,
    csharp: `httpClient.DefaultRequestHeaders.Add("x-api-key", Environment.GetEnvironmentVariable("BRISKSMS_API_KEY"));
var result = await httpClient.PostAsJsonAsync("https://api.brisksms.app/v1/messages/send", new {
    recipientPhone = "+255754000111",
    message = "Habari Juma! Invoice #INV-2026-44 is confirmed. Karibu sana!",
    simSlot = 1
});`,
    response: `{
  "success": true,
  "data": {
    "success": true,
    "messageId": "msg_992019401",
    "status": "QUEUED",
    "recipientPhone": "+255754000111",
    "costCredits": 1
  }
}`
  },
  dispatch: {
    curl: `curl -X POST https://api.brisksms.app/v1/messaging/campaigns \\
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "organizationId": "org_c9401ab88",
    "name": "Order Dispatch Broadcast",
    "templateText": "Habari [name]! Order #[orderId] dispatched.",
    "recipients": [
      { "phoneNumber": "+255754000111", "variables": { "name": "Juma", "orderId": "4829" } },
      { "phoneNumber": "+255713999222", "variables": { "name": "Amani", "orderId": "4830" } }
    ]
  }'`,
    node: `const res = await fetch("https://api.brisksms.app/v1/messaging/campaigns", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${sessionToken}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    organizationId: "org_c9401ab88",
    name: "Order Dispatch Broadcast",
    templateText: "Habari [name]! Order #[orderId] dispatched.",
    recipients: [
      { phoneNumber: "+255754000111", variables: { name: "Juma", orderId: "4829" } },
      { phoneNumber: "+255713999222", variables: { name: "Amani", orderId: "4830" } }
    ]
  })
});`,
    ts: `const res = await fetch("https://api.brisksms.app/v1/messaging/campaigns", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${sessionToken}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    organizationId: "org_c9401ab88",
    name: "Order Dispatch Broadcast",
    templateText: "Habari [name]! Order #[orderId] dispatched.",
    recipients: [
      { phoneNumber: "+255754000111", variables: { name: "Juma", orderId: "4829" } },
      { phoneNumber: "+255713999222", variables: { name: "Amani", orderId: "4830" } }
    ]
  })
});`,
    python: `response = requests.post(
    "https://api.brisksms.app/v1/messaging/campaigns",
    headers={"Authorization": f"Bearer {session_token}"},
    json={
        "organizationId": "org_c9401ab88",
        "name": "Order Dispatch Broadcast",
        "templateText": "Habari [name]! Order #[orderId] dispatched.",
        "recipients": [
            {"phoneNumber": "+255754000111", "variables": {"name": "Juma", "orderId": "4829"}},
            {"phoneNumber": "+255713999222", "variables": {"name": "Amani", "orderId": "4830"}}
        ]
    },
    timeout=15
)`,
    go: `req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.brisksms.app/v1/messaging/campaigns", body)
req.Header.Set("Authorization", "Bearer "+sessionToken)
req.Header.Set("Content-Type", "application/json")
resp, err := httpClient.Do(req)`,
    php: `$response = Http::withToken($sessionToken)
    ->post('https://api.brisksms.app/v1/messaging/campaigns', [
        'organizationId' => 'org_c9401ab88',
        'name'           => 'Order Dispatch Broadcast',
        'templateText'   => 'Habari [name]! Order #[orderId] dispatched.',
        'recipients'     => [
            ['phoneNumber' => '+255754000111', 'variables' => ['name' => 'Juma', 'orderId' => '4829']]
        ]
    ]);`,
    java: `HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("https://api.brisksms.app/v1/messaging/campaigns"))
    .header("Authorization", "Bearer " + sessionToken)
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(jsonPayload))
    .build();`,
    csharp: `httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", sessionToken);
var campaign = await httpClient.PostAsJsonAsync("https://api.brisksms.app/v1/messaging/campaigns", payload);`,
    response: `{
  "success": true,
  "data": {
    "campaign": {
      "id": "cmp_8829401",
      "organizationId": "org_c9401ab88",
      "name": "Order Dispatch Broadcast",
      "status": "DRAFT",
      "recipientCount": 2
    },
    "recipients": [
      { "id": "rec_01", "recipientPhone": "+255754000111", "status": "QUEUED" },
      { "id": "rec_02", "recipientPhone": "+255713999222", "status": "QUEUED" }
    ]
  }
}`
  },
  device: {
    curl: `curl -X GET "https://api.brisksms.app/v1/devices?organizationId=org_c9401ab88" \\
  -H "Authorization: Bearer YOUR_SESSION_TOKEN"`,
    node: `const res = await fetch("https://api.brisksms.app/v1/devices?organizationId=org_c9401ab88", {
  headers: { "Authorization": \`Bearer \${sessionToken}\` }
});
const { data } = await res.json();
console.log("Devices:", data);`,
    ts: `const res = await fetch("https://api.brisksms.app/v1/devices?organizationId=org_c9401ab88", {
  headers: { "Authorization": \`Bearer \${sessionToken}\` }
});`,
    python: `devices = requests.get(
    "https://api.brisksms.app/v1/devices?organizationId=org_c9401ab88",
    headers={"Authorization": f"Bearer {session_token}"},
    timeout=15
).json()`,
    go: `req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.brisksms.app/v1/devices?organizationId=org_c9401ab88", nil)
req.Header.Set("Authorization", "Bearer "+sessionToken)
resp, err := httpClient.Do(req)`,
    php: `$devices = Http::withToken($sessionToken)->get('https://api.brisksms.app/v1/devices?organizationId=org_c9401ab88')->json();`,
    java: `HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("https://api.brisksms.app/v1/devices?organizationId=org_c9401ab88"))
    .header("Authorization", "Bearer " + sessionToken)
    .GET()
    .build();`,
    csharp: `httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", sessionToken);
var devices = await httpClient.GetFromJsonAsync<JsonDocument>("https://api.brisksms.app/v1/devices?organizationId=org_c9401ab88");`,
    response: `{
  "success": true,
  "data": [
    {
      "id": "dev_s23_relay_01",
      "label": "Samsung Galaxy S23 Relay",
      "deviceModel": "SM-S911B",
      "status": "ACTIVE",
      "batteryPercentage": 94,
      "networkType": "WIFI",
      "isCharging": true
    }
  ]
}`
  }
};

// 1.5 Quickstart Interactive Data (Direct HTTPS REST)
const qsData = {
  node: {
    step1: {
      title: "1. Generate Scoped API Key",
      desc: "Create a scoped `bsk_live_*` key in Merchant Console -> Zapier & Webhooks and expose it via `BRISKSMS_API_KEY`.",
      code: "export BRISKSMS_API_KEY=bsk_live_your_scoped_key"
    },
    step2: {
      title: "2. Configure Standard REST Call",
      desc: "No third-party SDK package is required. Use built-in `fetch` (Node 18+ / Bun) with `x-api-key` authentication.",
      code: `const headers = {\n  "x-api-key": process.env.BRISKSMS_API_KEY,\n  "Content-Type": "application/json"\n};`
    },
    step3: {
      title: "3. Dispatch SMS or Query Payments",
      desc: "Send transactional SMS or check live payment verification over HTTPS.",
      code: `const res = await fetch("https://api.brisksms.app/v1/messages/send", {\n  method: "POST", headers,\n  body: JSON.stringify({ recipientPhone: "+255754000111", message: "Payment received" })\n});`
    }
  },
  ts: {
    step1: {
      title: "1. Reference Monorepo Contracts",
      desc: "Inside the BriskSMS monorepo, import shared DTOs and enums directly from `@brisksms/shared`.",
      code: `import { PaymentProvider, TransactionState } from "@brisksms/shared";`
    },
    step2: {
      title: "2. Authenticate Requests",
      desc: "Pass your scoped `bsk_live_*` key in the `x-api-key` header (or `Bearer` JWT for console routes).",
      code: `const headers = { "x-api-key": process.env.BRISKSMS_API_KEY!, "Content-Type": "application/json" };`
    },
    step3: {
      title: "3. Call Typed REST Endpoints",
      desc: "Invoke `/v1/payments/stk-push`, `/v1/messages/send`, or `/v1/reconciliation/verify` via `fetch`.",
      code: `const res = await fetch("https://api.brisksms.app/v1/payments/stk-push", { method: "POST", headers, body });`
    }
  },
  python: {
    step1: {
      title: "1. Install Standard HTTP Client",
      desc: "Use Python's `requests` or `httpx` library directly against BriskSMS `/v1/*` JSON endpoints.",
      code: "pip install requests"
    },
    step2: {
      title: "2. Configure Headers",
      desc: "Load `BRISKSMS_API_KEY` from your environment secrets.",
      code: `import os, requests\nHEADERS = {"x-api-key": os.environ["BRISKSMS_API_KEY"]}`
    },
    step3: {
      title: "3. Send Transactional SMS",
      desc: "Post recipients and messages to `/v1/messages/send` with an idempotency key.",
      code: `res = requests.post("https://api.brisksms.app/v1/messages/send", headers=HEADERS, json={"recipientPhone": "+255754000111", "message": "Code: 8829"}, timeout=15)`
    }
  },
  go: {
    step1: {
      title: "1. Use Go Standard `net/http`",
      desc: "No external dependency required beyond the Go standard library.",
      code: `import ("bytes"; "net/http"; "os")`
    },
    step2: {
      title: "2. Set Auth Header",
      desc: "Attach `x-api-key` and `Content-Type: application/json` to outgoing HTTP requests.",
      code: `req.Header.Set("x-api-key", os.Getenv("BRISKSMS_API_KEY"))\nreq.Header.Set("Content-Type", "application/json")`
    },
    step3: {
      title: "3. Execute With Context",
      desc: "Send JSON payloads to `POST /v1/messages/send` or `POST /v1/payments/stk-push`.",
      code: `req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.brisksms.app/v1/messages/send", bytes.NewReader(payload))`
    }
  },
  php: {
    step1: {
      title: "1. Use Laravel Http / cURL",
      desc: "Standard Laravel HTTP client or PHP cURL works directly with BriskSMS REST endpoints.",
      code: `// Use Illuminate\\Support\\Facades\\Http or ext-curl`
    },
    step2: {
      title: "2. Configure API Key Header",
      desc: "Store `BRISKSMS_API_KEY` in `.env` and attach it as `x-api-key`.",
      code: `$headers = ['x-api-key' => env('BRISKSMS_API_KEY')];`
    },
    step3: {
      title: "3. Dispatch Notifications",
      desc: "Send SMS receipts when a checkout completes in your billing or store system.",
      code: `Http::withHeaders($headers)->post('https://api.brisksms.app/v1/messages/send', ['recipientPhone' => '+255754000111', 'message' => 'Confirmed']);`
    }
  },
  java: {
    step1: {
      title: "1. Use JDK 17+ `java.net.http.HttpClient`",
      desc: "Standard library HTTP client for Spring Boot 3 and enterprise Java services.",
      code: `HttpClient client = HttpClient.newHttpClient();`
    },
    step2: {
      title: "2. Build Request",
      desc: "Attach `x-api-key` or `Authorization: Bearer ...` and JSON body.",
      code: `HttpRequest req = HttpRequest.newBuilder().uri(URI.create("https://api.brisksms.app/v1/messages/send")).header("x-api-key", System.getenv("BRISKSMS_API_KEY")).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(json)).build();`
    },
    step3: {
      title: "3. Read JSON Response",
      desc: "Inspect HTTP status and `{ success, data }` envelope.",
      code: `HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());`
    }
  },
  csharp: {
    step1: {
      title: "1. Configure `HttpClient`",
      desc: "Register typed `HttpClient` in .NET 8 DI for BriskSMS REST API calls.",
      code: `builder.Services.AddHttpClient("BriskSMS", c => c.DefaultRequestHeaders.Add("x-api-key", config["BriskSMS:ApiKey"]));`
    },
    step2: {
      title: "2. Send Typed JSON Payloads",
      desc: "Use `System.Net.Http.Json` `PostAsJsonAsync` against `/v1/*` routes.",
      code: `var res = await client.PostAsJsonAsync("https://api.brisksms.app/v1/messages/send", payload);`
    },
    step3: {
      title: "3. Handle Idempotency",
      desc: "Include `Idempotency-Key` headers for retry-safe payment and SMS requests.",
      code: `res.EnsureSuccessStatusCode();`
    }
  }
};

let activeEndpoint = "stk_push";
let activeLang = "curl";
let activeQsLang = "node";

function updatePlayground() {
  const reqEl = document.getElementById("reqCode");
  const respEl = document.getElementById("respCode");
  const data = endpointsData[activeEndpoint];

  reqEl.innerHTML = `<pre style="margin: 0; white-space: pre-wrap;"><code>${escapeHtml(data[activeLang] || data.curl)}</code></pre>`;
  respEl.innerHTML = `<pre style="margin: 0; white-space: pre-wrap;"><code>${escapeHtml(data.response)}</code></pre>`;
}

function setEndpoint(ep, el) {
  activeEndpoint = ep;
  document.querySelectorAll(".ep-btn").forEach(btn => btn.classList.remove("active"));
  if (el) {
    el.classList.add("active");
  } else if (window.event && window.event.target) {
    window.event.target.classList.add("active");
  }
  updatePlayground();
}

function setLang(lang, el) {
  activeLang = lang;
  document.querySelectorAll(".lang-btn").forEach(btn => btn.classList.remove("active"));
  if (el) {
    el.classList.add("active");
  } else if (window.event && window.event.target) {
    window.event.target.classList.add("active");
  }
  updatePlayground();
}

function setQsLang(lang, el) {
  activeQsLang = lang;
  document.querySelectorAll(".qs-lang-btn").forEach(b => b.classList.remove("active"));
  if (el) {
    el.classList.add("active");
  } else if (window.event && window.event.target) {
    window.event.target.classList.add("active");
  }
  const steps = qsData[lang];
  const container = document.getElementById("qsSteps");
  if (!steps || !container) return;
  container.innerHTML = `
        <div class="qs-step-card">
          <div>
            <div class="qs-step-num">1</div>
            <h4 class="qs-step-title">${escapeHtml(steps.step1.title)}</h4>
            <p class="qs-step-desc">${escapeHtml(steps.step1.desc)}</p>
          </div>
          <div class="qs-code-box"><code>${escapeHtml(steps.step1.code)}</code></div>
        </div>
        <div class="qs-step-card">
          <div>
            <div class="qs-step-num">2</div>
            <h4 class="qs-step-title">${escapeHtml(steps.step2.title)}</h4>
            <p class="qs-step-desc">${escapeHtml(steps.step2.desc)}</p>
          </div>
          <div class="qs-code-box"><code>${escapeHtml(steps.step2.code)}</code></div>
        </div>
        <div class="qs-step-card">
          <div>
            <div class="qs-step-num">3</div>
            <h4 class="qs-step-title">${escapeHtml(steps.step3.title)}</h4>
            <p class="qs-step-desc">${escapeHtml(steps.step3.desc)}</p>
          </div>
          <div class="qs-code-box"><code>${escapeHtml(steps.step3.code)}</code></div>
        </div>
      `;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 2. Webhook Simulator Data
const webhookEvents = {
  reconciled: `{
  "event": "payment.reconciled",
  "timestamp": "2026-11-05T14:22:19Z",
  "signature": "hmac_sha256_8f492a88190d7c2a1...",
  "data": {
    "paymentId": "pay_984920194829",
    "invoiceId": "INV-8829",
    "amountMinor": 15000000,
    "currency": "TZS",
    "provider": "VODACOM_MPESA",
    "providerReference": "09B8291M",
    "payerName": "AMANI MTEMI",
    "status": "SETTLED"
  }
}`,
  underpaid: `{
  "event": "payment.underpaid",
  "timestamp": "2026-11-05T14:24:02Z",
  "signature": "hmac_sha256_993b49182...",
  "data": {
    "paymentId": "pay_984920220194",
    "invoiceId": "INV-8830",
    "amountPaidMinor": 10000000,
    "expectedAmountMinor": 15000000,
    "underpaidDifferenceMinor": 5000000,
    "currency": "TZS",
    "status": "PARTIAL_SETTLEMENT"
  }
}`,
  review: `{
  "event": "payment.review_required",
  "timestamp": "2026-11-05T14:25:30Z",
  "signature": "hmac_sha256_bb4829184...",
  "data": {
    "paymentId": "pay_984920330199",
    "amountMinor": 8500000,
    "reason": "AMBIGUOUS_CUSTOMER_REFERENCE",
    "candidateInvoices": ["INV-8831", "INV-8832"],
    "status": "PENDING_HUMAN_REVIEW"
  }
}`,
  delayed: `{
  "event": "payment.delayed",
  "timestamp": "2026-11-10T16:21:00Z",
  "signature": "hmac_sha256_ee471029...",
  "data": {
    "invoiceId": "INV-8829",
    "expectedAmountMinor": 15000000,
    "elapsedSeconds": 45,
    "carrierStatus": "SMSC_DELIVERY_PENDING",
    "suggestedAction": "PROMPT_CUSTOMER_TRANSACTION_ID"
  }
}`,
  delivered: `{
  "event": "message.delivered",
  "timestamp": "2026-11-05T14:26:15Z",
  "signature": "hmac_sha256_aa772910...",
  "data": {
    "messageId": "msg_492019842",
    "campaignId": "cmp_8829401",
    "recipient": "+255754000111",
    "carrier": "VODACOM_TZ",
    "deliveredAt": "2026-11-05T14:26:14Z",
    "deliveryStatus": "CONFIRMED"
  }
}`,
  device_offline: `{
  "event": "device.relay_disconnected",
  "timestamp": "2026-11-05T14:27:00Z",
  "signature": "hmac_sha256_ff1829102...",
  "data": {
    "deviceId": "dev_s23_relay_01",
    "lastSeenAt": "2026-11-05T14:20:10Z",
    "alert": "HEARTBEAT_TIMEOUT_300S",
    "suggestedAction": "CHECK_ANDROID_DEVICE_WIFI_OR_DATA"
  }
}`,
  battery_low: `{
  "event": "device.battery_low",
  "timestamp": "2026-11-10T16:21:30Z",
  "signature": "hmac_sha256_cc99104...",
  "data": {
    "deviceId": "dev_s23_relay_01",
    "batteryPercentage": 12,
    "isCharging": false,
    "suggestedAction": "CONNECT_AC_CHARGER_IMMEDIATELY"
  }
}`
};

function setWebhookEvent(evtKey, el) {
  document.querySelectorAll(".wh-trigger-btn").forEach(btn => btn.classList.remove("active"));
  if (el) {
    el.classList.add("active");
  } else if (typeof event !== "undefined" && event && event.target) {
    event.target.classList.add("active");
  } else {
    const btn = document.querySelector(`.wh-trigger-btn[onclick*="${evtKey}"]`);
    if (btn) btn.classList.add("active");
  }
  const disp = document.getElementById("whPayload");
  if (disp && webhookEvents[evtKey]) {
    disp.innerHTML = `<pre style="margin: 0; white-space: pre-wrap;"><code>${escapeHtml(webhookEvents[evtKey])}</code></pre>`;
  }
}

// 2.5 Zapier & Spreadsheet Automation Snippets
const zapierSnippets = {
  zapier_post: `// Setup: "Webhooks by Zapier" -> Event: "Custom Request"
// Sends SMS through your dedicated cellular SIM relay without per-message carrier fees

URL: https://api.brisksms.app/v1/messages/send
Method: POST
Headers:
  Content-Type: application/json
  x-api-key: YOUR_BRISKSMS_API_KEY

Data (JSON Payload):
{
  "recipient": "{{1.Phone_Number}}",
  "message": "Habari {{1.Customer_Name}}, malipo yako ya TZS {{1.Amount}} kwa agizo #{{1.Invoice_ID}} yamethibitishwa. Asante!",
  "simSlot": 1,
  "priority": "HIGH"
}`,
  app_action: `// Zapier Action: BriskSMS -> "Send Cellular SMS"
// Input Fields Mapped Dynamically from Google Sheets or Excel:
{
  "Account": "BriskSMS Tanzania (Organization #org_99182910)",
  "Recipient Phone Number": "{{1.Phone_Number}}",          // e.g. +255712345678
  "SMS Body Template": "Habari {{1.Customer_Name}}, ankara #{{1.Invoice_ID}} ya TZS {{1.Amount}} imekamilika kikamilifu.",
  "SIM Card Selection": "SIM 1 (Vodacom M-Pesa)",
  "TCRA Curfew Compliance": "AUTOMATIC_QUEUE_DURING_CURFEW" // Buffers between 20:00 - 07:00 EAT
}`,
  curl_cli: `curl -X POST https://api.brisksms.app/v1/messages/send \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_BRISKSMS_API_KEY" \\
  -d '{
    "recipient": "+255712345678",
    "message": "Habari Juma, ankara #INV-492 ya TZS 150,000 imekamilika kikamilifu.",
    "simSlot": 1,
    "priority": "HIGH"
  }'`,
  response_json: `{
  "success": true,
  "data": {
    "success": true,
    "messageId": "msg_01hy8z7a9b3c4d5e6f7g8h9j",
    "status": "SENT",
    "recipientPhone": "+255712345678",
    "costCredits": 1
  }
}`
};

function setZapierTab(tab, el) {
  document.querySelectorAll(".zapier-tab-btn").forEach(btn => btn.classList.remove("active"));
  if (el) {
    el.classList.add("active");
  } else {
    const btn = document.querySelector(`.zapier-tab-btn[onclick*="${tab}"]`);
    if (btn) btn.classList.add("active");
  }
  const display = document.getElementById("zapierCodeDisplay");
  if (display && zapierSnippets[tab]) {
    display.innerHTML = `<pre style="margin: 0; white-space: pre-wrap;"><code>${escapeHtml(zapierSnippets[tab])}</code></pre>`;
  }
}

// 2.8 Verification & Claim Reconciliation Snippets (Direct HTTPS REST)
const resilienceSnippets = {
  ts: `// Verify and reconcile an observed payment against an open invoice via REST
async function verifyPaymentSettlement(organizationId: string, paymentId: string, invoiceId: string) {
  const res = await fetch("https://api.brisksms.app/v1/reconciliation/verify", {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${process.env.BRISKSMS_SESSION_TOKEN!}\`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      organizationId,
      paymentId,
      invoiceId,
      verificationMethod: "MANUAL_FINANCE_APPROVAL",
      notes: "Confirmed against payment reference claim record"
    })
  });
  return res.json();
}`,
  python: `import os, requests

def verify_payment_settlement(organization_id: str, payment_id: str, invoice_id: str):
    res = requests.post(
        "https://api.brisksms.app/v1/reconciliation/verify",
        headers={"Authorization": f"Bearer {os.getenv('BRISKSMS_SESSION_TOKEN')}"},
        json={
            "organizationId": organization_id,
            "paymentId": payment_id,
            "invoiceId": invoice_id,
            "verificationMethod": "MANUAL_FINANCE_APPROVAL",
        },
        timeout=15,
    )
    return res.json()`,
  curl: `curl -X POST https://api.brisksms.app/v1/reconciliation/verify \\
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "organizationId": "org_c9401ab88",
    "paymentId": "pay_984920194829",
    "invoiceId": "inv_8829",
    "verificationMethod": "MANUAL_FINANCE_APPROVAL"
  }'`
};

let activeResilienceLang = "ts";

function setResilienceLang(lang, el) {
  activeResilienceLang = lang;
  if (el) {
    const card = el.closest(".terminal-container");
    if (card) {
      card.querySelectorAll(".lang-btn").forEach(b => b.classList.remove("active"));
    }
    el.classList.add("active");
  }
  const codeEl = document.getElementById("resilienceReqCode");
  if (codeEl && resilienceSnippets[lang]) {
    codeEl.innerHTML = `<pre style="margin: 0; white-space: pre-wrap;"><code>${escapeHtml(resilienceSnippets[lang])}</code></pre>`;
  }
}

// Initialize UI on load
updatePlayground();
setQsLang("node", document.querySelector(".qs-lang-btn.active"));
setWebhookEvent("reconciled", document.querySelector(".wh-trigger-btn.active"));
setZapierTab("zapier_post", document.querySelector(".zapier-tab-btn.active"));
setResilienceLang("ts", document.querySelector("#resilience .lang-btn.active"));

// 3. Grounded 3D Chrome Spheres Motion Engine
const s1 = document.getElementById("sphere1");
const s1Shadow = document.getElementById("sphereShadow1");
const s2 = document.getElementById("sphere2");
const s3 = document.getElementById("sphere3");
const heroCard = document.getElementById("heroCard");

let mouseX = 0, mouseY = 0;
let currentX1 = 0, currentY1 = 0;
let currentX2 = 0, currentY2 = 0;
let currentX3 = 0, currentY3 = 0;
const isReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!isReducedMotion) {
  window.addEventListener("mousemove", (e) => {
    const rect = heroCard.getBoundingClientRect();
    if (e.clientY < rect.bottom + 200) {
      mouseX = (e.clientX - window.innerWidth / 2);
      mouseY = (e.clientY - window.innerHeight / 2);
    }
  }, { passive: true });

  function animateSpheres(time) {
    // Grounded Landing Physics: Sphere 1 rests solidly on its contact plane
    const float1 = Math.sin(time * 0.001) * 1.5; /* Micro-breathing of 1.5px, firmly grounded */
    const rot1 = Math.sin(time * 0.0005) * 2;

    const float2 = Math.cos(time * 0.0014) * 5;
    const float3 = Math.sin(time * 0.0009) * 10;

    // Smooth Mouse Parallax Easing
    currentX1 += (mouseX * 0.02 - currentX1) * 0.05;
    currentY1 += (mouseY * 0.02 - currentY1) * 0.05;

    currentX2 += (mouseX * -0.035 - currentX2) * 0.05;
    currentY2 += (mouseY * -0.035 - currentY2) * 0.05;

    currentX3 += (mouseX * 0.05 - currentX3) * 0.05;
    currentY3 += (mouseY * 0.05 - currentY3) * 0.05;

    // Scroll Parallax
    const scrollY = window.scrollY;
    const scrollOffset1 = scrollY * 0.06;
    const scrollOffset2 = scrollY * 0.12;
    const scrollOffset3 = scrollY * -0.15;

    if (s1) s1.style.transform = `translate3d(${currentX1}px, ${float1 + currentY1 - scrollOffset1}px, 0) rotate(${rot1}deg)`;
    if (s1Shadow) s1Shadow.style.transform = `translate3d(${currentX1 * 0.7}px, ${currentY1 * 0.15}px, 0) scale(${1 + float1 * 0.008})`;
    if (s2) s2.style.transform = `translate3d(${currentX2}px, ${float2 + currentY2 - scrollOffset2}px, 0)`;
    if (s3) s3.style.transform = `translate3d(${currentX3}px, ${float3 + currentY3 - scrollOffset3}px, 0)`;

    // Scroll-Dynamic Chrome Atmosphere Across Entire Website
    const atmoSpheres = document.querySelectorAll(".atmospheric-sphere");
    atmoSpheres.forEach((atmo, i) => {
      const speed = parseFloat(atmo.dataset.speed || 0.1);
      const rect = atmo.getBoundingClientRect();
      if (rect.top < window.innerHeight + 350 && rect.bottom > -350) {
        const relScroll = (window.innerHeight / 2 - rect.top) * speed;
        const atmoFloat = Math.sin(time * 0.0011 + i) * 7;
        const atmoRot = Math.sin(time * 0.0006 + i) * 3 + (scrollY * 0.02 * (i % 2 === 0 ? 1 : -1));
        atmo.style.transform = `translate3d(${currentX1 * 0.3 * (i % 2 === 0 ? 1 : -1)}px, ${atmoFloat + relScroll}px, 0) rotate(${atmoRot}deg)`;
      }
    });

    requestAnimationFrame(animateSpheres);
  }

  requestAnimationFrame(animateSpheres);
}


// Docs sidebar: mark the section currently being read
{
  const docLinks = document.querySelectorAll('.docs-sidebar a');
  if (docLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map();
    docLinks.forEach((a) => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) byId.set(target, a);
    });
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        docLinks.forEach((l) => l.removeAttribute('aria-current'));
        byId.get(entry.target).setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-25% 0px -65% 0px' });
    byId.forEach((_, section) => spy.observe(section));
  }
}
