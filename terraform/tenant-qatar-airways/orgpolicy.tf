# AI-005: cloud policy frameworks, applied at the project and audited continuously by the platform. These constraints
# keep the project inside the design: data stays in approved locations, nothing gets a public address, buckets are not
# public, and long-lived service-account keys cannot be made.

resource "google_org_policy_policy" "resource_locations" {
  name   = "projects/${var.project_id}/policies/gcp.resourceLocations"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      values {
        allowed_values = [for r in var.approved_regions : "in:${r}-locations"]
      }
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_org_policy_policy" "no_public_sql" {
  name   = "projects/${var.project_id}/policies/sql.restrictPublicIp"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_org_policy_policy" "no_vm_external_ip" {
  name   = "projects/${var.project_id}/policies/compute.vmExternalIpAccess"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      deny_all = "TRUE"
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_org_policy_policy" "uniform_bucket_access" {
  name   = "projects/${var.project_id}/policies/storage.uniformBucketLevelAccess"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_org_policy_policy" "public_access_prevention" {
  name   = "projects/${var.project_id}/policies/storage.publicAccessPrevention"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_org_policy_policy" "no_service_account_keys" {
  name   = "projects/${var.project_id}/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_org_policy_policy" "run_ingress" {
  name   = "projects/${var.project_id}/policies/run.allowedIngress"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      values {
        allowed_values = ["internal-and-cloud-load-balancing"]
      }
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_org_policy_policy" "require_cmek" {
  name   = "projects/${var.project_id}/policies/gcp.restrictNonCmekServices"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      values {
        denied_values = ["sqladmin.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com"]
      }
    }
  }
  depends_on = [google_project_service.enabled]
}
