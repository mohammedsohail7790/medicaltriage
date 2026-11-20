-- Sprint 5: incident reports, quality-review samples, teleconsultant handoffs and referral letters.
CREATE TABLE "clinical_work_items" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "case_ref" TEXT,
    "organization_id" TEXT,
    "created_by" TEXT NOT NULL,
    "assignee" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "clinical_work_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "clinical_work_items_kind_status_idx" ON "clinical_work_items"("kind", "status");
CREATE INDEX "clinical_work_items_case_ref_idx" ON "clinical_work_items"("case_ref");
