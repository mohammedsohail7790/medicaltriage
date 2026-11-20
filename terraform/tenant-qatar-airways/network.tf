# AI-006 / AI-007 / AI-013 / M-038: private networking. The application, database and secrets are reachable only from
# inside the network; the only public door is the load balancer, behind the web application firewall.

locals {
  all_services = [
    "run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "cloudkms.googleapis.com",
    "compute.googleapis.com", "vpcaccess.googleapis.com", "servicenetworking.googleapis.com", "binaryauthorization.googleapis.com",
    "containeranalysis.googleapis.com", "logging.googleapis.com", "pubsub.googleapis.com", "orgpolicy.googleapis.com",
    "securitycenter.googleapis.com", "privilegedaccessmanager.googleapis.com", "cloudresourcemanager.googleapis.com"
  ]
}

resource "google_project_service" "enabled" {
  for_each           = toset(local.all_services)
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "tenant" {
  name                    = "aimltriage-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "app" {
  name                     = "aimltriage-app"
  region                   = var.region
  network                  = google_compute_network.tenant.id
  ip_cidr_range            = var.vpc_cidr
  private_ip_google_access = true

  log_config {
    aggregation_interval = "INTERVAL_5_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

resource "google_vpc_access_connector" "runtime" {
  name          = "aimltriage-connector"
  region        = var.region
  network       = google_compute_network.tenant.name
  ip_cidr_range = var.connector_cidr
  depends_on    = [google_project_service.enabled]
}

# Private service access: Cloud SQL gets a private address only.
resource "google_compute_global_address" "private_services" {
  name          = "aimltriage-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.tenant.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.tenant.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

# Default deny, in both directions. Only what the application needs is opened.
resource "google_compute_firewall" "deny_all_ingress" {
  name      = "aimltriage-deny-all-ingress"
  network   = google_compute_network.tenant.name
  direction = "INGRESS"
  priority  = 65000
  deny {
    protocol = "all"
  }
  source_ranges = ["0.0.0.0/0"]
  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}

resource "google_compute_firewall" "allow_connector_to_database" {
  name      = "aimltriage-connector-to-database"
  network   = google_compute_network.tenant.name
  direction = "EGRESS"
  priority  = 900
  allow {
    protocol = "tcp"
    ports    = ["5432"]
  }
  destination_ranges = ["${google_compute_global_address.private_services.address}/${google_compute_global_address.private_services.prefix_length}"]
}

# Google APIs (Secret Manager, Cloud SQL admin, logging) are reached on the private "restricted" range, not the internet.
resource "google_compute_firewall" "allow_google_apis" {
  name      = "aimltriage-google-apis"
  network   = google_compute_network.tenant.name
  direction = "EGRESS"
  priority  = 910
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
  destination_ranges = ["199.36.153.4/30"]
}

resource "google_compute_firewall" "allow_integrations" {
  count     = length(var.integration_egress_cidrs) > 0 ? 1 : 0
  name      = "aimltriage-integrations"
  network   = google_compute_network.tenant.name
  direction = "EGRESS"
  priority  = 920
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
  destination_ranges = var.integration_egress_cidrs
}

resource "google_compute_firewall" "deny_all_egress" {
  name      = "aimltriage-deny-all-egress"
  network   = google_compute_network.tenant.name
  direction = "EGRESS"
  priority  = 65000
  deny {
    protocol = "all"
  }
  destination_ranges = ["0.0.0.0/0"]
}

# AI-008 / M-038: the web application firewall. Layer 7 rules for the common attack classes, an allow-list of approved
# networks, a request-rate limit, and deny by default.
resource "google_compute_security_policy" "waf" {
  name        = "aimltriage-waf"
  description = "Web application firewall for the AiMlTriage endpoint"

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable = true
    }
  }

  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "SQL injection"
  }
  rule {
    action   = "deny(403)"
    priority = 1010
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "Cross-site scripting"
  }
  rule {
    action   = "deny(403)"
    priority = 1020
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('lfi-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "Local file inclusion"
  }
  rule {
    action   = "deny(403)"
    priority = 1030
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('rce-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "Remote code execution"
  }
  rule {
    action   = "throttle"
    priority = 2000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = var.approved_ingress_cidrs
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 600
        interval_sec = 60
      }
    }
    description = "Approved networks, rate limited"
  }
  rule {
    action   = "deny(403)"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default deny: not an approved network"
  }
}

resource "google_compute_ssl_policy" "modern" {
  name            = "aimltriage-tls"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_global_address" "edge" {
  name = "aimltriage-edge"
}

resource "google_compute_managed_ssl_certificate" "edge" {
  name = "aimltriage-cert"
  managed {
    domains = [var.domain]
  }
}

resource "google_compute_region_network_endpoint_group" "run" {
  name                  = "aimltriage-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.app.name
  }
}

resource "google_compute_backend_service" "app" {
  name            = "aimltriage-backend"
  protocol        = "HTTPS"
  security_policy = google_compute_security_policy.waf.id
  backend {
    group = google_compute_region_network_endpoint_group.run.id
  }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "app" {
  name            = "aimltriage-urlmap"
  default_service = google_compute_backend_service.app.id
}

resource "google_compute_target_https_proxy" "app" {
  name             = "aimltriage-https-proxy"
  url_map          = google_compute_url_map.app.id
  ssl_certificates = [google_compute_managed_ssl_certificate.edge.id]
  ssl_policy       = google_compute_ssl_policy.modern.id
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "aimltriage-https"
  target                = google_compute_target_https_proxy.app.id
  port_range            = "443"
  ip_address            = google_compute_global_address.edge.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Private DNS so Google APIs resolve to the restricted private range (199.36.153.4/30) from inside the network.
resource "google_dns_managed_zone" "googleapis" {
  name        = "aimltriage-googleapis"
  dns_name    = "googleapis.com."
  description = "Google APIs resolve to the restricted private range"
  visibility  = "private"
  private_visibility_config {
    networks {
      network_url = google_compute_network.tenant.id
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_dns_record_set" "restricted_a" {
  name         = "restricted.googleapis.com."
  managed_zone = google_dns_managed_zone.googleapis.name
  type         = "A"
  ttl          = 300
  rrdatas      = ["199.36.153.4", "199.36.153.5", "199.36.153.6", "199.36.153.7"]
}

resource "google_dns_record_set" "wildcard_cname" {
  name         = "*.googleapis.com."
  managed_zone = google_dns_managed_zone.googleapis.name
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["restricted.googleapis.com."]
}
