-- Widen webhook_endpoints.secret to TEXT so AES-256-GCM encrypted webhook HMAC secrets fit without truncation.
ALTER TABLE "webhook_endpoints"
  ALTER COLUMN "secret" TYPE TEXT;
