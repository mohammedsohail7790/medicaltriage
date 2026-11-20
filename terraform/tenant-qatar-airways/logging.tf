# AI-015 / NFR-167: infrastructure and security logs are kept in one place in an approved region and copied to
# Qatar Airways' SIEM through a Pub/Sub topic they own.

resource "google_logging_project_bucket_config" "central" {
  project        = var.project_id
  location       = var.region
  bucket_id      = "aimltriage-central"
  retention_days = var.log_retention_days
  locked         = var.lock_log_bucket
  depends_on     = [google_project_service.enabled]
}

resource "google_logging_project_sink" "central" {
  name                   = "aimltriage-central"
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.central.id}"
  filter                 = ""
  unique_writer_identity = true
}

resource "google_logging_project_sink" "siem" {
  name                   = "aimltriage-siem"
  destination            = "pubsub.googleapis.com/${var.siem_pubsub_topic}"
  filter                 = "severity>=NOTICE OR protoPayload.@type=\"type.googleapis.com/google.cloud.audit.AuditLog\" OR resource.type=\"http_load_balancer\""
  unique_writer_identity = true
}

resource "google_pubsub_topic_iam_member" "siem_writer" {
  topic  = var.siem_pubsub_topic
  role   = "roles/pubsub.publisher"
  member = google_logging_project_sink.siem.writer_identity
}
