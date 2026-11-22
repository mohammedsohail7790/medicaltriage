# NFR-130: scheduled platform jobs run in their own Cloud Run job, not inside the instances that serve nurses. The
# service sets SCHEDULER_MODE=external so it never runs them; this job starts what is due once a minute. The
# database is the tenant's own (sql.tf), so heavy jobs are also kept off any shared database.

resource "google_cloud_run_v2_job" "scheduler" {
  name     = "aimltriage-scheduler"
  location = var.region

  template {
    template {
      service_account = google_service_account.runtime.email
      max_retries     = 0
      timeout         = "600s"

      vpc_access {
        connector = google_vpc_access_connector.runtime.id
        egress    = "ALL_TRAFFIC"
      }

      containers {
        image   = var.image
        command = ["node"]
        args    = ["dist/schedulerJob.js"]

        resources {
          limits = { cpu = "2", memory = "2Gi" }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "DATA_REGION"
          value = var.region
        }
        env {
          name  = "APPROVED_DATA_REGIONS"
          value = join(",", var.approved_regions)
        }
        # M-019, M-020: the job reads and writes the same encrypted fields as the service, through the same KMS key.
        env {
          name  = "FIELD_ENCRYPTION_PROVIDER"
          value = "gcp-kms"
        }
        env {
          name  = "FIELD_ENCRYPTION_KMS_KEY"
          value = local.field_key_id
        }
        dynamic "env" {
          for_each = google_secret_manager_secret.app
          content {
            name = upper(replace(env.key, "-", "_"))
            value_source {
              secret_key_ref {
                secret  = env.value.secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.runtime]
}

resource "google_service_account" "scheduler_trigger" {
  account_id   = "aimltriage-scheduler-trigger"
  display_name = "Starts the scheduler job"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_trigger" {
  name     = google_cloud_run_v2_job.scheduler.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_trigger.email}"
}

resource "google_cloud_scheduler_job" "scheduler_tick" {
  name      = "aimltriage-scheduler-tick"
  region    = var.region
  schedule  = "* * * * *"
  time_zone = "Etc/UTC"

  retry_config {
    retry_count = 0
  }

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.scheduler.name}:run"
    http_method = "POST"
    oauth_token {
      service_account_email = google_service_account.scheduler_trigger.email
    }
  }

  depends_on = [google_project_service.enabled]
}
