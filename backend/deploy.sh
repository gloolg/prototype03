#!/usr/bin/env bash
# deploy.sh — Cloud Run deployment for MetaRegistry backend
# Run from: metanetwork-eqi/backend/
# Requires: gcloud CLI authenticated, project set to metanetwork-eqi

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SERVICE="metaregistry-backend"
REGION="europe-west1"
PROJECT="metanetwork-eqi"

# Load .env (must exist locally, never committed)
if [ ! -f .env ]; then
  echo "ERROR: .env not found in $(pwd). Aborting."
  exit 1
fi

# Source .env to validate required vars exist
set -a
# shellcheck disable=SC1091
source .env
set +a

REQUIRED=(
  IT_A_ADDRESS IT_A_PRIVATE_KEY
  IT_B_ADDRESS IT_B_PRIVATE_KEY
  IT_C_ADDRESS IT_C_PRIVATE_KEY
  IT_D_ADDRESS IT_D_PRIVATE_KEY
  RPC_A RPC_B RPC_C RPC_D
  DB_GCS_BUCKET
)
for var in "${REQUIRED[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is missing or empty in .env. Aborting."
    exit 1
  fi
done

# ── Build --set-env-vars string ───────────────────────────────────────────────
# DB is mounted from GCS via Cloud Storage FUSE at /data (persistent across cold starts).
# Prerequisites: DB_GCS_BUCKET must exist; service account needs roles/storage.objectAdmin.
#
# Private keys are pulled from Secret Manager (never passed as plaintext env vars).
# Create secrets once before first deploy:
#   printf '%s' "${IT_A_PRIVATE_KEY}" | gcloud secrets create metaregistry-it-a-pk --data-file=- --project="${PROJECT}"
#   printf '%s' "${IT_B_PRIVATE_KEY}" | gcloud secrets create metaregistry-it-b-pk --data-file=- --project="${PROJECT}"
#   printf '%s' "${IT_C_PRIVATE_KEY}" | gcloud secrets create metaregistry-it-c-pk --data-file=- --project="${PROJECT}"
#   printf '%s' "${IT_D_PRIVATE_KEY}" | gcloud secrets create metaregistry-it-d-pk --data-file=- --project="${PROJECT}"
# Service account also needs roles/secretmanager.secretAccessor.

SECRET_REFS="IT_A_PRIVATE_KEY=metaregistry-it-a-pk:latest"
SECRET_REFS="${SECRET_REFS},IT_B_PRIVATE_KEY=metaregistry-it-b-pk:latest"
SECRET_REFS="${SECRET_REFS},IT_C_PRIVATE_KEY=metaregistry-it-c-pk:latest"
SECRET_REFS="${SECRET_REFS},IT_D_PRIVATE_KEY=metaregistry-it-d-pk:latest"

ENV_VARS="IT_A_ADDRESS=${IT_A_ADDRESS}"
ENV_VARS="${ENV_VARS},IT_B_ADDRESS=${IT_B_ADDRESS}"
ENV_VARS="${ENV_VARS},IT_C_ADDRESS=${IT_C_ADDRESS}"
ENV_VARS="${ENV_VARS},IT_D_ADDRESS=${IT_D_ADDRESS}"
ENV_VARS="${ENV_VARS},RPC_A=${RPC_A}"
ENV_VARS="${ENV_VARS},RPC_B=${RPC_B}"
ENV_VARS="${ENV_VARS},RPC_C=${RPC_C}"
ENV_VARS="${ENV_VARS},RPC_D=${RPC_D}"
ENV_VARS="${ENV_VARS},DB_PATH=/data/metaregistry.sqlite"
ENV_VARS="${ENV_VARS},GAS_THRESHOLD_A=${GAS_THRESHOLD_A:-0.005}"
ENV_VARS="${ENV_VARS},GAS_THRESHOLD_B=${GAS_THRESHOLD_B:-0.005}"
ENV_VARS="${ENV_VARS},GAS_THRESHOLD_C=${GAS_THRESHOLD_C:-0.01}"
ENV_VARS="${ENV_VARS},GAS_THRESHOLD_D=${GAS_THRESHOLD_D:-0.005}"

# ── Deploy ────────────────────────────────────────────────────────────────────
echo ""
echo "Deploying ${SERVICE} to Cloud Run (${REGION})..."
echo "Project: ${PROJECT}"
echo ""

gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --platform managed \
  --execution-environment gen2 \
  --allow-unauthenticated \
  --set-env-vars "${ENV_VARS}" \
  --set-secrets "${SECRET_REFS}" \
  --add-volume "name=db-storage,type=cloud-storage,bucket=${DB_GCS_BUCKET}" \
  --add-volume-mount "volume=db-storage,mount-path=/data" \
  --min-instances 0 \
  --max-instances 1 \
  --memory 512Mi \
  --timeout 60

echo ""
echo "Done. Service URL:"
gcloud run services describe "${SERVICE}" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --format "value(status.url)"
