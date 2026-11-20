# AI-009, AI-010, NFR-161: secrets live in Secret Manager, replicated only to approved regions, encrypted with the
# tenant's key, readable only by the application's own service account, and due for rotation on a schedule.

resource "google_service_account" "runtime" {
  account_id   = var.runtime_service_account
  display_name = "AiMlTriage runtime (least privilege)"
}

resource "google_pubsub_topic" "secret_rotation" {
  name                       = "aimltriage-secret-rotation"
  message_storage_policy {
    allowed_persistence_regions = var.approved_regions
  }
}

resource "google_secret_manager_secret" "app" {
  for_each  = toset(var.secrets)
  secret_id = each.value

  replication {
    user_managed {
      dynamic "replicas" {
        for_each = toset(var.approved_regions)
        content {
          location = replicas.value
          customer_managed_encryption {
            kms_key_name = local.data_key_id
          }
        }
      }
    }
  }

  rotation {
    rotation_period    = var.secret_rotation_period
    next_rotation_time = timeadd(timestamp(), "2160h")
  }

  topics {
    name = google_pubsub_topic.secret_rotation.id
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [rotation[0].next_rotation_time]
  }

  depends_on = [google_kms_crypto_key_iam_member.secretmanager]
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# Nobody else holds secret access: this is the only binding. A person who needs a secret goes through the privileged
# access request in iam.tf.
