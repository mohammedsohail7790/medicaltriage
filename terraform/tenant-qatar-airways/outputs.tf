# The residency inventory (M-028, NFR-063, NFR-087, NFR-088, NFR-089): where each kind of data is held. Every value
# here is one of approved_regions, checked by the validations in variables.tf and the location policy in orgpolicy.tf.

output "residency_inventory" {
  description = "Where each service, backup, log and key lives."
  value = {
    application            = var.region
    database               = google_sql_database_instance.primary.region
    database_backups       = var.region
    database_point_in_time = var.region
    secrets                = var.approved_regions
    encryption_keys        = var.region
    central_logs           = var.region
    siem_topic_policy      = var.approved_regions
    disaster_recovery      = var.dr_region == null ? "not configured: agree with Qatar Airways IT" : var.dr_region
    log_archive            = var.region
    cost_export            = var.region
    environment_databases  = { for k, m in module.environment : k => var.region }
    edge_load_balancer     = "global anycast address; the application and its data stay in ${var.region}"
  }
}

output "edge_ip_address" {
  value = google_compute_global_address.edge.address
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "database_connection_name" {
  value = google_sql_database_instance.primary.connection_name
}

output "recovery_tier" {
  value = var.recovery_tier
}
