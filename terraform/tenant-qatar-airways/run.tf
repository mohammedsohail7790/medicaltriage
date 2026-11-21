# AI-006 / AI-007: the application accepts traffic only from the load balancer, and reaches the database and Google
# services only through the private network.

resource "google_cloud_run_v2_service" "app" {
  name     = "aimltriage"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  binary_authorization {
    use_default = true
  }

  template {
    service_account = google_service_account.runtime.email

    # NFR-034: more than one instance, spread over zones by the platform, so no single instance is a point of failure.
    scaling {
      min_instance_count = 2
      max_instance_count = 20
    }

    vpc_access {
      connector = google_vpc_access_connector.runtime.id
      egress    = "ALL_TRAFFIC"
    }

    containers {
      image = var.image

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
      env {
        name  = "SSO_ENFORCED"
        value = "true"
      }
      # NFR-130: scheduled jobs run in the separate Cloud Run job (jobs.tf), never in these instances.
      env {
        name  = "SCHEDULER_MODE"
        value = "external"
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

  # NFR-073 / NFR-137 / NFR-139: traffic can be split between a stable and a canary revision, and rolled back by
  # setting the canary share to 0. With no stable revision named, all traffic follows the latest revision.
  dynamic "traffic" {
    for_each = var.stable_revision == "" ? [1] : []
    content {
      type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
      percent = 100
    }
  }
  dynamic "traffic" {
    for_each = var.stable_revision != "" ? [1] : []
    content {
      type     = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"
      revision = var.stable_revision
      percent  = var.canary_revision == "" ? 100 : 100 - var.canary_percent
    }
  }
  dynamic "traffic" {
    for_each = var.stable_revision != "" && var.canary_revision != "" && var.canary_percent > 0 ? [1] : []
    content {
      type     = "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"
      revision = var.canary_revision
      percent  = var.canary_percent
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.runtime]
}

# Only the load balancer's identity may invoke the service; there is no public invoker.
resource "google_cloud_run_v2_service_iam_member" "lb_only" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.tenant.number}@serverless-robot-prod.iam.gserviceaccount.com"
}
