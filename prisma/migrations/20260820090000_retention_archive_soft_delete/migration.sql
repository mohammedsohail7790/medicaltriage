-- NFR-056: archive handoff tracking.
ALTER TABLE "archived_records" ADD COLUMN "handed_off_at" TIMESTAMP(3), ADD COLUMN "handoff_reference" TEXT;
CREATE INDEX "archived_records_handed_off_at_idx" ON "archived_records"("handed_off_at");

-- NFR-013: soft delete for more record types. Encounters are the clinical record and are never soft-deleted by users; they leave only through the retention process.
ALTER TABLE "dependents" ADD COLUMN "deleted_at" TIMESTAMP(3), ADD COLUMN "deleted_by" TEXT;
ALTER TABLE "ccp_drafts" ADD COLUMN "deleted_at" TIMESTAMP(3), ADD COLUMN "deleted_by" TEXT;
ALTER TABLE "ccp_webhook_records" ADD COLUMN "deleted_at" TIMESTAMP(3), ADD COLUMN "deleted_by" TEXT;
