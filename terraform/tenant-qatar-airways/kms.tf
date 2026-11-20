# AI-009 (soft delete and purge protection), AI-012 (customer-managed keys), NFR-161 (rotation).
# Keys are created in an approved region only. A key cannot be deleted, only its versions can be scheduled for
# destruction, and that waits out key_destroy_delay (the soft-delete window); the key ring and keys are also
# protected from removal by Terraform.

locals {
  use_own_key = var.customer_managed_key == null
}

resource "google_kms_key_ring" "tenant" {
  count    = local.use_own_key ? 1 : 0
  name     = "aimltriage"
  location = var.region
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key" "data" {
  count                      = local.use_own_key ? 1 : 0
  name                       = "data-at-rest"
  key_ring                   = google_kms_key_ring.tenant[0].id
  rotation_period            = var.kms_rotation_period
  destroy_scheduled_duration = var.key_destroy_delay
  purpose                    = "ENCRYPT_DECRYPT"

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "HSM"
  }

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  data_key_id = local.use_own_key ? google_kms_crypto_key.data[0].id : var.customer_managed_key
}

# Only the services that must use the key may do so, and nobody is granted permission to destroy key versions.
resource "google_kms_crypto_key_iam_member" "sql" {
  count         = local.use_own_key ? 1 : 0
  crypto_key_id = google_kms_crypto_key.data[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.tenant.number}@gcp-sa-cloud-sql.iam.gserviceaccount.com"
}

data "google_project" "tenant" {
  project_id = var.project_id
}

resource "google_kms_crypto_key_iam_member" "secretmanager" {
  count         = local.use_own_key ? 1 : 0
  crypto_key_id = google_kms_crypto_key.data[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.tenant.number}@gcp-sa-secretmanager.iam.gserviceaccount.com"
}
