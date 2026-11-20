# M-013, M-014, M-015, NFR-032, NFR-034, NFR-036: high availability and disaster recovery, in approved regions only.
#   inside the region   the database is REGIONAL (a standby in another zone, automatic failover) and the application runs
#                       at least two instances the platform spreads across zones
#   to another region   when dr_region is set (it must be an approved region), a cross-region read replica is kept up to date
#                       and can be promoted. It has its own key in the DR region. There is no overseas replication.
# The recovery tier sets the targets the rehearsal is measured against; it is not a promise until Qatar Airways agrees it.

resource "google_kms_key_ring" "dr" {
  count    = var.dr_region != null && local.use_own_key ? 1 : 0
  name     = "aimltriage-dr"
  location = var.dr_region
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key" "dr" {
  count                      = var.dr_region != null && local.use_own_key ? 1 : 0
  name                       = "data-at-rest-dr"
  key_ring                   = google_kms_key_ring.dr[0].id
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

resource "google_kms_crypto_key_iam_member" "sql_dr" {
  count         = var.dr_region != null && local.use_own_key ? 1 : 0
  crypto_key_id = google_kms_crypto_key.dr[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.tenant.number}@gcp-sa-cloud-sql.iam.gserviceaccount.com"
}

resource "google_sql_database_instance" "dr_replica" {
  count                = var.dr_region != null ? 1 : 0
  name                 = "aimltriage-db-dr"
  region               = var.dr_region
  database_version     = "POSTGRES_16"
  master_instance_name = google_sql_database_instance.primary.name
  deletion_protection  = true
  encryption_key_name  = local.use_own_key ? google_kms_crypto_key.dr[0].id : var.customer_managed_key

  replica_configuration {
    failover_target = false
  }

  settings {
    tier              = var.database_tier
    availability_type = "REGIONAL"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.tenant.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.sql_dr]
}
