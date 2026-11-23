-- Platform-level settings, set by the platform admin. The first one is the billing workspace:
-- the organization whose verified payments fund BriskSMS's own subscriptions.
CREATE TABLE "platform_settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);
