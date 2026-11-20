-- NFR-004 shared rate limit counters; NFR-003 API consumer onboarding.
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key", "window_start")
);
CREATE INDEX "rate_limit_buckets_window_start_idx" ON "rate_limit_buckets"("window_start");

CREATE TABLE "api_consumers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "sizing" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "client_id" TEXT,
    "client_secret_hash" TEXT,
    "role" TEXT,
    "rate_limit_per_minute" INTEGER,
    "allowed_ips" JSONB,
    "decision_note" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "last_used_at" TIMESTAMP(3),
    CONSTRAINT "api_consumers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "api_consumers_client_id_key" ON "api_consumers"("client_id");
CREATE INDEX "api_consumers_status_idx" ON "api_consumers"("status");
