-- NFR-129: the completed-cases page (organisation, status, newest first) measured 22 ms at 500,000 cases and growing with the
-- data, because the existing index could not return rows in order. This index can. It only adds; nothing is changed or removed.
CREATE INDEX "triage_queue_items_org_status_updated_idx" ON "triage_queue_items"("organization_id", "status", "updated_at" DESC);
