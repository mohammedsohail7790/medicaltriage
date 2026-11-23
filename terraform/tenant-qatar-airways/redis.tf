# NFR-076 / NFR-121: an optional shared cache that speaks the Redis protocol (Memorystore for Redis), for reference and
# configuration data only. Off by default; each instance then keeps its own memory cache. When it is on, the connection
# address (with its password) and the server certificate authority are application secrets set outside Terraform:
# add "redis-url" and "redis-ca-cert" to var.secrets and fill them from the instance's auth string and server_ca_certs.

variable "enable_shared_cache" {
  description = "Create a Memorystore (Redis protocol) instance for reference-data caching, shared by every application instance."
  type        = bool
  default     = false
}

variable "shared_cache_memory_gb" {
  type    = number
  default = 1
}

resource "google_redis_instance" "cache" {
  count                   = var.enable_shared_cache ? 1 : 0
  name                    = "aimltriage-cache"
  region                  = var.region
  tier                    = "STANDARD_HA"
  memory_size_gb          = var.shared_cache_memory_gb
  authorized_network      = google_compute_network.tenant.id
  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  customer_managed_key    = local.data_key_id

  lifecycle {
    precondition {
      condition     = contains(var.secrets, "redis-url") && contains(var.secrets, "redis-ca-cert")
      error_message = "Add redis-url and redis-ca-cert to var.secrets so the application can reach the cache."
    }
  }

  depends_on = [google_service_networking_connection.private_services, google_project_service.enabled]
}

output "shared_cache_address" {
  description = "Host and port of the shared cache, for building the redis-url secret (rediss://:AUTH_STRING@host:port)."
  value       = var.enable_shared_cache ? "${google_redis_instance.cache[0].host}:${google_redis_instance.cache[0].port}" : null
}
