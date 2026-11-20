terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State for this tenant is kept in the tenant's own bucket, in an approved region. Configure at init:
  #   terraform init -backend-config="bucket=<tenant-state-bucket>" -backend-config="prefix=aimltriage"
  # This module never shares state, a backend or a provider with the existing SOC 2 project in ../main.tf.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}
