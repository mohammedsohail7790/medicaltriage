# AI-011 / M-040: continuous monitoring for security findings. Security Command Center findings of high or critical
# severity are streamed to the same Pub/Sub topic that feeds Qatar Airways' SIEM, where the remediation clock starts
# (Critical within 30 calendar days of awareness; High as agreed). Threat detection for the database, storage and the
# container runtime is part of the Security Command Center tier Qatar Airways licenses for the project.

resource "google_scc_project_notification_config" "findings" {
  config_id    = "aimltriage-findings"
  project      = var.project_id
  description  = "High and critical security findings to the SIEM"
  pubsub_topic = var.siem_pubsub_topic

  streaming_config {
    filter = "severity=\"HIGH\" OR severity=\"CRITICAL\""
  }

  depends_on = [google_project_service.enabled]
}
