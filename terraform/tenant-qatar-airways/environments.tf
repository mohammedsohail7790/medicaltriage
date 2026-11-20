# NFR-068 / NFR-069 / NFR-070: SIT, UAT and stage, each with its own database and service, from one definition. Adding an
# entry to var.environments provisions another (NFR, training, performance) on request. The promotion path between them is
# in docs/operations/release-and-environments.md.

module "environment" {
  for_each = var.environments
  source   = "./modules/environment"

  name                   = each.key
  project_id             = var.project_id
  region                 = var.region
  network_id             = google_compute_network.tenant.id
  connector_id           = google_vpc_access_connector.runtime.id
  kms_key_id             = local.data_key_id
  image                  = var.image
  database_tier          = each.value.database_tier
  min_instances          = each.value.min_instances
  domain                 = var.domain
  private_services_ready = google_service_networking_connection.private_services.id
}
