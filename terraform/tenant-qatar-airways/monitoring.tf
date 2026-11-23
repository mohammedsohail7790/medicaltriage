# M-024, NFR-102, NFR-104, NFR-068: alerting, push to Qatar Airways, dashboard access and availability measurement.

resource "google_monitoring_notification_channel" "email" {
  for_each     = toset(var.alert_emails)
  display_name = "Alerts: ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }
}

# NFR-102: alerts are pushed in real time to an HTTPS endpoint Qatar Airways runs.
resource "google_monitoring_notification_channel" "push" {
  count        = var.alert_push_url == null ? 0 : 1
  display_name = "Qatar Airways alert endpoint"
  type         = "webhook_tokenauth"
  labels = {
    url = var.alert_push_url
  }
  sensitive_labels {
    auth_token = var.alert_push_token
  }
}

locals {
  channels = concat([for c in google_monitoring_notification_channel.email : c.id], [for c in google_monitoring_notification_channel.push : c.id])
}

# Availability, measured from outside, every minute. The same check gives the monthly availability figure for NFR-068.
resource "google_monitoring_uptime_check_config" "app" {
  display_name = "AiMlTriage availability"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path           = "/healthz"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.domain
    }
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  display_name = "AiMlTriage is not answering"
  combiner     = "OR"
  conditions {
    display_name = "Uptime check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.app.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "180s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
    }
  }
  notification_channels = local.channels
  alert_strategy {
    auto_close = "1800s"
  }
}

resource "google_monitoring_alert_policy" "database_down" {
  display_name = "Database is not available"
  combiner     = "OR"
  conditions {
    display_name = "Cloud SQL instance not up"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/up\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.primary.name}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "120s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = local.channels
}

resource "google_monitoring_alert_policy" "disk" {
  display_name = "Database disk is filling"
  combiner     = "OR"
  conditions {
    display_name = "Disk utilisation above ${var.disk_alert_percent}%"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.primary.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.disk_alert_percent / 100
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = local.channels
}

resource "google_logging_metric" "backup_failed" {
  name   = "aimltriage_backup_failed"
  filter = "resource.type=\"cloudsql_database\" AND severity>=ERROR AND (protoPayload.methodName=~\"backup\" OR textPayload=~\"(?i)backup\")"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "backup_failed" {
  display_name = "A database backup failed"
  combiner     = "OR"
  conditions {
    display_name = "Backup error logged"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.backup_failed.name}\" AND resource.type=\"cloudsql_database\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = local.channels
}

# M-013 / M-014: when a disaster-recovery replica exists, the lag between it and the primary is the data that would be
# lost in a failover, so it must stay within the tier's recovery point objective.
resource "google_monitoring_alert_policy" "replica_lag" {
  count        = var.dr_region != null ? 1 : 0
  display_name = "DR replica is behind the recovery point objective"
  combiner     = "OR"
  conditions {
    display_name = "Replica lag above the RPO"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/replication/replica_lag\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.dr_replica[0].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.recovery_tier.rpo_minutes * 60
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  notification_channels = local.channels
}

# NFR-104: Qatar Airways can see every dashboard in real time, read-only.
resource "google_project_iam_member" "dashboard_viewers" {
  for_each = toset(var.dashboard_viewers)
  project  = var.project_id
  role     = "roles/monitoring.viewer"
  member   = each.value
}

# NFR-132: alerts on 95th-percentile latency, error rate and queue backlog age, with thresholds Qatar Airways can set.
resource "google_monitoring_alert_policy" "latency_p95" {
  display_name = "Request latency (95th percentile) is high"
  combiner     = "OR"
  conditions {
    display_name = "p95 latency above ${var.alert_p95_latency_ms} ms"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.app.name}\" AND metric.type=\"run.googleapis.com/request_latencies\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_p95_latency_ms
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }
    }
  }
  notification_channels = local.channels
}

resource "google_monitoring_alert_policy" "error_rate" {
  display_name = "Server error rate is high"
  combiner     = "OR"
  conditions {
    display_name = "Server errors above ${var.alert_error_rate * 100} percent of requests"
    condition_threshold {
      filter             = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.app.name}\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.label.response_code_class=\"5xx\""
      denominator_filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.app.name}\" AND metric.type=\"run.googleapis.com/request_count\""
      comparison         = "COMPARISON_GT"
      threshold_value    = var.alert_error_rate
      duration           = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  notification_channels = local.channels
}

# The application writes a queue_backlog log line (emitQueueBacklogMetric in src/services/queueOrchestration.ts) on queue reads.
resource "google_logging_metric" "queue_backlog_age" {
  name   = "aimltriage_queue_oldest_waiting_item_age_seconds"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.app.name}\" AND jsonPayload.type=\"queue_metric\" AND jsonPayload.metric=\"queue_backlog\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "s"
  }
  value_extractor = "EXTRACT(jsonPayload.oldestWaitingAgeSeconds)"
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 30
      growth_factor      = 2
      scale              = 1
    }
  }
}

resource "google_monitoring_alert_policy" "queue_backlog_age" {
  display_name = "Queue backlog age is high"
  combiner     = "OR"
  conditions {
    display_name = "Oldest waiting queue item older than ${var.alert_queue_backlog_age_seconds} seconds"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.queue_backlog_age.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.alert_queue_backlog_age_seconds
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_99"
      }
    }
  }
  notification_channels = local.channels
}

# NFR-085: any scheduled job that finishes with a failure raises an alert, so a customisation that adds a job is covered without a change here.
resource "google_monitoring_alert_policy" "job_failure" {
  display_name = "A scheduled job failed"
  combiner     = "OR"
  conditions {
    display_name = "A Cloud Run job execution ended without success"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_job\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result!=\"succeeded\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  notification_channels = local.channels
}
