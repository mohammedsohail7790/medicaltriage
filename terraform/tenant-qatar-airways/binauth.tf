# NFR-158 (code signing) and M-040 (binary authorisation): only a container image signed by the release pipeline's
# attestor is admitted. An unsigned or altered image is blocked and the attempt is logged.

resource "google_kms_key_ring" "signing" {
  count    = local.use_own_key ? 1 : 0
  name     = "aimltriage-signing"
  location = var.region
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key" "attestation" {
  count    = local.use_own_key ? 1 : 0
  name     = "release-attestation"
  key_ring = google_kms_key_ring.signing[0].id
  purpose  = "ASYMMETRIC_SIGN"
  version_template {
    algorithm        = "EC_SIGN_P256_SHA256"
    protection_level = "HSM"
  }
  lifecycle {
    prevent_destroy = true
  }
}

data "google_kms_crypto_key_version" "attestation" {
  count      = local.use_own_key ? 1 : 0
  crypto_key = google_kms_crypto_key.attestation[0].id
}

resource "google_container_analysis_note" "release" {
  name = "aimltriage-release-attestor-note"
  attestation_authority {
    hint {
      human_readable_name = "AiMlTriage release pipeline"
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_binary_authorization_attestor" "release" {
  count = local.use_own_key ? 1 : 0
  name  = "aimltriage-release"
  attestation_authority_note {
    note_reference = google_container_analysis_note.release.name
    public_keys {
      id = data.google_kms_crypto_key_version.attestation[0].id
      pkix_public_key {
        public_key_pem      = data.google_kms_crypto_key_version.attestation[0].public_key[0].pem
        signature_algorithm = data.google_kms_crypto_key_version.attestation[0].public_key[0].algorithm
      }
    }
  }
}

resource "google_binary_authorization_policy" "enforce" {
  count = local.use_own_key ? 1 : 0

  default_admission_rule {
    evaluation_mode         = "REQUIRE_ATTESTATION"
    enforcement_mode        = "ENFORCED_BLOCK_AND_AUDIT_LOG"
    require_attestations_by = [google_binary_authorization_attestor.release[0].name]
  }

  global_policy_evaluation_mode = "ENABLE"
}
