#!/usr/bin/env bash
# Creates the GitHub `release` environment (main branch only) and stores the
# Azure OIDC ids the Windows job uses to sign with Artifact Signing.
# No client secret: auth is a federated credential scoped to this environment.
#
# Usage: scripts/set-windows-signing-secrets.sh <client-id> <tenant-id> <subscription-id>
#        (omit any argument to be prompted for it)
set -euo pipefail

REPO="GraphicMeat/mail-vault-app"
ENV="release"

CLIENT_ID="${1:-}"; TENANT_ID="${2:-}"; SUBSCRIPTION_ID="${3:-}"
[ -n "$CLIENT_ID" ]       || read -rp "Application (client) ID: " CLIENT_ID
[ -n "$TENANT_ID" ]       || read -rp "Directory (tenant) ID: " TENANT_ID
[ -n "$SUBSCRIPTION_ID" ] || read -rp "Subscription ID: " SUBSCRIPTION_ID

guid='^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
for v in "$CLIENT_ID" "$TENANT_ID" "$SUBSCRIPTION_ID"; do
  [[ "$v" =~ $guid ]] || { echo "not a GUID: '$v'" >&2; exit 1; }
done

# Only a job running from main may enter the environment, so only main can
# obtain a signing token.
gh api -X PUT "repos/$REPO/environments/$ENV" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api "repos/$REPO/environments/$ENV/deployment-branch-policies" \
    --jq '.branch_policies[].name' | grep -qx main \
  || gh api -X POST "repos/$REPO/environments/$ENV/deployment-branch-policies" \
       -f name=main -f type=branch >/dev/null

gh secret set AZURE_CLIENT_ID       --repo "$REPO" --env "$ENV" --body "$CLIENT_ID"
gh secret set AZURE_TENANT_ID       --repo "$REPO" --env "$ENV" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$REPO" --env "$ENV" --body "$SUBSCRIPTION_ID"

gh secret list --repo "$REPO" --env "$ENV"
