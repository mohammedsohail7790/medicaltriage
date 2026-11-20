# One non-production environment (SIT, UAT, stage, NFR, training ...): its own database instance, runtime account, service
# and availability check, so a fault or an upgrade in one cannot reach another (NFR-035, NFR-068, NFR-069).

variable "name" { type = string }
variable "project_id" { type = string }
variable "region" { type = string }
variable "network_id" { type = string }
variable "connector_id" { type = string }
variable "kms_key_id" { type = string }
variable "image" { type = string }
variable "database_tier" { type = string }
variable "min_instances" { type = number }
variable "domain" { type = string }
variable "private_services_ready" { type = any }

resource "google_service_account" "runtime" {
  account_id   = "aimltriage-${var.name}"
  display_name = "AiMlTriage ${var.name} runtime"
}

resource "google_sql_database_instance" "db" {
  name                = "aimltriage-${var.name}-db"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true
  encryption_key_name = var.kms_key_id

  settings {
    tier              = var.database_tier
    availability_type = "ZONAL"
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled  = true
      location = var.region
    }
    password_validation_policy {
      enable_password_policy = true
      min_length             = 16
      complexity             = "COMPLEXITY_DEFAULT"
    }
  }

  depends_on = [var.private_services_ready]
}

resource "google_sql_database" "app" {
  name     = "aimltriage"
  instance = google_sql_database_instance.db.name
}

resource "google_cloud_run_v2_service" "app" {
  name     = "aimltriage-${var.name}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  binary_authorization {
    use_default = true
  }

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = 5
    }
    vpc_access {
      connector = var.connector_id
      egress    = "ALL_TRAFFIC"
    }
    containers {
      image = var.image
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "ENVIRONMENT_NAME"
        value = var.name
      }
    }
  }
}

output "service_name" {
  value = google_cloud_run_v2_service.app.name
}

output "database_instance" {
  value = google_sql_database_instance.db.name
}
