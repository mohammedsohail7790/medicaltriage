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

# M-019, M-020, AI-012: the key that wraps the data keys of field-level encryption. The application calls Cloud KMS
# to wrap and unwrap, so no key-encryption material is held by the service. With customer_managed_key set, that key
# is used instead and Qatar Airways must grant the runtime service account roles/cloudkms.cryptoKeyEncrypterDecrypter
# on it (the member is the runtime_service_account output).
resource "google_kms_crypto_key" "field" {
  count                      = local.use_own_key ? 1 : 0
  name                       = "field-encryption"
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
  field_key_id = local.use_own_key ? google_kms_crypto_key.field[0].id : var.customer_managed_key
}

resource "google_kms_crypto_key_iam_member" "runtime_field" {
  count         = local.use_own_key ? 1 : 0
  crypto_key_id = google_kms_crypto_key.field[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.runtime.email}"
}
