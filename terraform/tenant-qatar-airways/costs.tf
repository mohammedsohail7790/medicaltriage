# NFR-116 / AI-018: cost data for the tenant. A budget with alerts, an export to a dataset in the approved region, and
# read access for Qatar Airways' cost team. Linking the export to the billing account is a billing-console step that only
# the billing administrator can take (see docs/cost-visibility-setup.md).

resource "google_bigquery_dataset" "billing_export" {
  dataset_id  = "aimltriage_billing_export"
  location    = var.region
  description = "Cost export for the AiMlTriage tenant"

  default_encryption_configuration {
    kms_key_name = local.data_key_id
  }
}

resource "google_bigquery_dataset_iam_member" "finops" {
  count      = var.finops_group == null ? 0 : 1
  dataset_id = google_bigquery_dataset.billing_export.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = var.finops_group
}

resource "google_billing_budget" "tenant" {
  count           = var.billing_account == null ? 0 : 1
  billing_account = var.billing_account
  display_name    = "AiMlTriage tenant"

  budget_filter {
    projects = ["projects/${data.google_project.tenant.number}"]
  }

  amount {
    specified_amount {
      units = tostring(var.monthly_budget)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = local.channels
  }
}
