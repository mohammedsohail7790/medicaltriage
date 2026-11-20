# Everything that differs between organisations is a variable. Nothing here names the existing SOC 2 project.

variable "project_id" {
  description = "The tenant's own Google Cloud project. Must not be the SOC 2 or demo project."
  type        = string
  validation {
    condition     = !contains(["triage-502706"], var.project_id)
    error_message = "Use the Qatar Airways tenant project, not the existing SOC 2 / demo project."
  }
}

variable "approved_regions" {
  description = "Locations Qatar Airways has approved for data, backups, logs, secrets and edge services (M-028, NFR-063, NFR-087). Nothing is created outside them."
  type        = list(string)
  default     = ["me-central1"]
  validation {
    condition     = length(var.approved_regions) > 0
    error_message = "Give at least one approved region."
  }
}

variable "region" {
  description = "Primary region. Must be an approved region."
  type        = string
  default     = "me-central1"
  validation {
    condition     = contains(var.approved_regions, var.region)
    error_message = "The primary region must be one of approved_regions."
  }
}

variable "dr_region" {
  description = "Disaster-recovery region (NFR-089). Must be an approved region; there is no overseas replication."
  type        = string
  default     = null
  validation {
    condition     = var.dr_region == null || contains(var.approved_regions, var.dr_region)
    error_message = "The DR region must be one of approved_regions."
  }
}

variable "domain" {
  description = "Public host name served through the load balancer and web application firewall."
  type        = string
}

variable "approved_ingress_cidrs" {
  description = "Networks allowed to reach the application (M-038, AI-008). Everything else is denied at the edge."
  type        = list(string)
  validation {
    condition     = length(var.approved_ingress_cidrs) > 0
    error_message = "Give at least one approved network; the edge denies all others."
  }
}

variable "vpc_cidr" {
  description = "Range for the application subnet."
  type        = string
  default     = "10.40.0.0/24"
}

variable "connector_cidr" {
  description = "Range for the serverless VPC connector (a /28 not used elsewhere)."
  type        = string
  default     = "10.40.8.0/28"
}

variable "image" {
  description = "Container image, by digest, from the tenant's registry. Binary Authorization admits it only if it is signed."
  type        = string
}

variable "runtime_service_account" {
  description = "Service account the application runs as (least privilege, no project-wide roles)."
  type        = string
  default     = "aimltriage-runtime"
}

variable "database_tier" {
  type    = string
  default = "db-custom-2-7680"
}

variable "kms_rotation_period" {
  description = "Rotation of encryption keys, in seconds (NFR-161: set to Qatar Airways' interval)."
  type        = string
  default     = "7776000s"
}

variable "secret_rotation_period" {
  description = "How often each secret is due for rotation, in seconds (NFR-161)."
  type        = string
  default     = "7776000s"
}

variable "customer_managed_key" {
  description = "Optional: the full id of a Qatar Airways-held key (Cloud EKM or their own key ring) to use instead of the key created here (AI-012). Null creates a key in this project."
  type        = string
  default     = null
}

variable "key_destroy_delay" {
  description = "How long a key version scheduled for destruction stays recoverable (soft delete, AI-009)."
  type        = string
  default     = "2592000s"
}

variable "admin_group" {
  description = "Organisation-managed group whose members may REQUEST temporary administrator access (NFR-159). No standing human administrator role is granted."
  type        = string
}

variable "approver_group" {
  description = "Group that approves privileged access requests."
  type        = string
}

variable "siem_pubsub_topic" {
  description = "Full id of the Pub/Sub topic that feeds Qatar Airways' SIEM (AI-015, NFR-167). The topic must be in an approved region."
  type        = string
}

variable "attestor_note_project" {
  type    = string
  default = null
}

variable "lock_log_bucket" {
  description = "Locking the audit log bucket's retention is permanent; turn it on only when Qatar Airways' retention period is final."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 400
}

variable "secrets" {
  description = "Names of the secrets the application needs. Values are set outside Terraform."
  type        = list(string)
  default     = ["auth-jwt-secret", "audit-hmac-secret", "field-encryption-key", "mfa-encryption-key", "database-url", "login-encryption-key"]
}

variable "integration_egress_cidrs" {
  description = "Addresses of the external systems the application must call (QHIE, EMR, email, teleconsultant service, SIEM collector). Egress is denied to everything else. Fill in from Qatar Airways' network design."
  type        = list(string)
  default     = []
}

# ---- Sprint 8: availability, environments, monitoring, release ----

variable "recovery_tier" {
  description = "The resilience tier Qatar Airways assigns the application. It sets the targets the recovery rehearsal is measured against (M-013, M-014)."
  type = object({
    name        = string
    rpo_minutes = number
    rto_minutes = number
  })
  default = {
    name        = "not yet agreed"
    rpo_minutes = 15
    rto_minutes = 240
  }
}

variable "backup_start_time" {
  description = "UTC start of the daily backup window, outside peak hours (NFR-037). 22:00 UTC is 01:00 in Doha."
  type        = string
  default     = "22:00"
}

variable "environments" {
  description = "Non-production environments (NFR-068, NFR-069), each with its own database. Add an entry to provision another (NFR, training, performance)."
  type = map(object({
    database_tier = string
    min_instances = number
  }))
  default = {
    sit   = { database_tier = "db-custom-1-3840", min_instances = 0 }
    uat   = { database_tier = "db-custom-1-3840", min_instances = 0 }
    stage = { database_tier = "db-custom-2-7680", min_instances = 1 }
  }
}

variable "stable_revision" {
  description = "The Cloud Run revision that serves normal traffic. Leave empty to follow the latest revision."
  type        = string
  default     = ""
}

variable "canary_revision" {
  description = "A new revision to receive a share of traffic first (NFR-073, NFR-137). Empty means no canary."
  type        = string
  default     = ""
}

variable "canary_percent" {
  description = "Share of traffic sent to the canary revision. Set to 0 (or empty the canary) to roll back instantly (NFR-139)."
  type        = number
  default     = 5
  validation {
    condition     = var.canary_percent >= 0 && var.canary_percent <= 100
    error_message = "canary_percent must be between 0 and 100."
  }
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "alert_push_url" {
  description = "Qatar Airways HTTPS endpoint that receives alerts in real time (NFR-102). Must be https."
  type        = string
  default     = null
  validation {
    condition     = var.alert_push_url == null || startswith(var.alert_push_url, "https://")
    error_message = "The alert endpoint must use https."
  }
}

variable "alert_push_token" {
  description = "Bearer token Qatar Airways' endpoint expects. Supplied at apply time, never stored in the repository."
  type        = string
  default     = null
  sensitive   = true
}

variable "dashboard_viewers" {
  description = "Groups given read-only access to the monitoring dashboards (NFR-104)."
  type        = list(string)
  default     = []
}

variable "billing_account" {
  description = "Billing account for the budget and cost export (NFR-116, AI-018). Null skips the budget."
  type        = string
  default     = null
}

variable "monthly_budget" {
  description = "Monthly spend that raises cost alerts, in the billing currency."
  type        = number
  default     = 5000
}

variable "finops_group" {
  description = "Group given read access to cost data for this tenant."
  type        = string
  default     = null
}

variable "log_archive_days" {
  description = "Days after which archived logs are deleted (NFR-108, NFR-109): set to Qatar Airways' rule."
  type        = number
  default     = 1095
}

variable "disk_alert_percent" {
  type    = number
  default = 80
}
