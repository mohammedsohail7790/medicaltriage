# NFR-159: privileged access is requested, approved and time-boxed. No human holds a standing administrator role.
# Administrators belong to the organisation's own group; Privileged Access Manager grants a role for a few hours
# after a second person approves, and records who asked, who approved and for what.

resource "google_privileged_access_manager_entitlement" "administrator" {
  entitlement_id       = "aimltriage-administrator"
  location             = "global"
  parent               = "projects/${var.project_id}"
  max_request_duration = "14400s"

  eligible_users {
    principals = [var.admin_group]
  }

  privileged_access {
    gcp_iam_access {
      resource_type = "cloudresourcemanager.googleapis.com/Project"
      resource      = "//cloudresourcemanager.googleapis.com/projects/${var.project_id}"
      role_bindings {
        role = "roles/run.admin"
      }
      role_bindings {
        role = "roles/cloudsql.admin"
      }
    }
  }

  requester_justification_config {
    unstructured {}
  }

  approval_workflow {
    manual_approvals {
      require_approver_justification = true
      steps {
        approvals_needed = 1
        approvers {
          principals = [var.approver_group]
        }
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

# Audit logs for every service and every kind of access are on, so a privileged session leaves a full trail.
resource "google_project_iam_audit_config" "all" {
  project = var.project_id
  service = "allServices"
  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}
