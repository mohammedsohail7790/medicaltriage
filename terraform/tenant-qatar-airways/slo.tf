# M-029: service level objectives, measured by the platform and shown on a live dashboard. The goals are variables and are
# placeholders until Qatar Airways agrees them; the burn-rate alert tells the on-call team when the error budget is being spent
# faster than the objective allows.

resource "google_monitoring_custom_service" "app" {
  service_id   = "aimltriage"
  display_name = "AiMlTriage"
}

resource "google_monitoring_slo" "availability" {
  service      = google_monitoring_custom_service.app.service_id
  slo_id       = "availability"
  display_name = "Requests answered without a server error"
  goal         = var.slo_availability_goal

  rolling_period_days = 30

  request_based_sli {
    good_total_ratio {
      good_service_filter  = "metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"${google_cloud_run_v2_service.app.name}\" metric.label.\"response_code_class\"!=\"5xx\""
      total_service_filter = "metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"${google_cloud_run_v2_service.app.name}\""
    }
  }
}

resource "google_monitoring_slo" "latency" {
  service      = google_monitoring_custom_service.app.service_id
  slo_id       = "latency"
  display_name = "Requests answered within the latency threshold"
  goal         = var.slo_latency_goal

  rolling_period_days = 30

  request_based_sli {
    distribution_cut {
      distribution_filter = "metric.type=\"run.googleapis.com/request_latencies\" resource.type=\"cloud_run_revision\" resource.label.\"service_name\"=\"${google_cloud_run_v2_service.app.name}\""
      range {
        max = var.slo_latency_threshold_ms
      }
    }
  }
}

resource "google_monitoring_alert_policy" "availability_burn" {
  display_name = "Availability error budget is burning fast"
  combiner     = "OR"
  conditions {
    display_name = "Burn rate above 10 over one hour"
    condition_threshold {
      filter          = "select_slo_burn_rate(\"${google_monitoring_slo.availability.name}\", \"3600s\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "0s"
    }
  }
  notification_channels = local.channels
}
