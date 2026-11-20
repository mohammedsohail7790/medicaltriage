# AI-013, M-018, NFR-153: the database has a private address only, requires TLS, enforces a password policy, is
# encrypted with the tenant's key, backs up inside the approved region, and is reached with two separate roles.

resource "google_sql_database_instance" "primary" {
  name                = "aimltriage-db"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true
  encryption_key_name = local.data_key_id

  settings {
    tier              = var.database_tier
    availability_type = "REGIONAL"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.tenant.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      location                       = var.region
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
      }
    }

    password_validation_policy {
      enable_password_policy      = true
      min_length                  = 16
      complexity                  = "COMPLEXITY_DEFAULT"
      reuse_interval              = 5
      disallow_username_substring = true
    }

    database_flags {
      name  = "log_connections"
      value = "on"
    }
    database_flags {
      name  = "log_disconnections"
      value = "on"
    }
    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.private_services, google_kms_crypto_key_iam_member.sql]
}

resource "google_sql_database" "app" {
  name     = "aimltriage"
  instance = google_sql_database_instance.primary.name
}

# NFR-153: the running application uses a role that can read and write rows and nothing more. A separate role runs
# migrations. Passwords are generated here and stored in Secret Manager; they never appear in plain text in the plan.
resource "random_password" "runtime_db" {
  length  = 32
  special = false
}

resource "random_password" "migration_db" {
  length  = 32
  special = false
}

resource "google_sql_user" "runtime" {
  name     = "aimltriage_runtime"
  instance = google_sql_database_instance.primary.name
  password = random_password.runtime_db.result
}

resource "google_sql_user" "migration" {
  name     = "aimltriage_migration"
  instance = google_sql_database_instance.primary.name
  password = random_password.migration_db.result
}
