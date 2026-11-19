-- M-021: administrator exports need a second administrator's approval.
CREATE TABLE "export_approvals" (
    "id" TEXT NOT NULL,
    "export_kind" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approver_id" TEXT,
    "comments" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "export_approvals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "export_approvals_status_expires_at_idx" ON "export_approvals"("status", "expires_at");
CREATE INDEX "export_approvals_requester_id_idx" ON "export_approvals"("requester_id");
