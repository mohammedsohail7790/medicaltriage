-- NFR-096: interface watcher log.
CREATE TABLE "interface_logs" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "direction" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "receiver" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "payload" JSONB,
    "status" INTEGER,
    "duration_ms" INTEGER,
    "attempts" INTEGER,
    "error" TEXT,

    CONSTRAINT "interface_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "interface_logs_integration_timestamp_idx" ON "interface_logs"("integration", "timestamp");
CREATE INDEX "interface_logs_correlation_id_idx" ON "interface_logs"("correlation_id");
