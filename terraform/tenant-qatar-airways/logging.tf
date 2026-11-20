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

# NFR-108 / NFR-109: logs are kept in the central bucket for log_retention_days (then purged by the bucket itself), and a
# copy goes to an archive bucket in the same approved region that moves to cold storage and is purged on Qatar Airways' rule.
resource "google_storage_bucket" "log_archive" {
  name                        = "${var.project_id}-aimltriage-log-archive"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  encryption {
    default_kms_key_name = local.data_key_id
  }

  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }

  lifecycle_rule {
    condition {
      age = var.log_archive_days
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_logging_project_sink" "archive" {
  name                   = "aimltriage-archive"
  destination            = "storage.googleapis.com/${google_storage_bucket.log_archive.name}"
  filter                 = ""
  unique_writer_identity = true
}

resource "google_storage_bucket_iam_member" "archive_writer" {
  bucket = google_storage_bucket.log_archive.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.archive.writer_identity
}
