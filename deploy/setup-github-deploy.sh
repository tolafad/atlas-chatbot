#!/usr/bin/env bash
# One-time setup so .github/workflows/deploy.yml can deploy without stored AWS keys.
# Run from the repo root with the AWS profile that owns the instance and a logged-in `gh`:
#   AWS_PROFILE=class bash deploy/setup-github-deploy.sh
# Safe to re-run: it updates what already exists.
set -euo pipefail

REPO=tolafad/atlas-chatbot
ROLE=atlas-chatbot-github-deploy
INSTANCE_ID=i-052d2c4204517077f
REGION=eu-west-2
ENV=production

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "AWS account: $ACCOUNT   GitHub repo: $REPO"

# --- AWS: GitHub OIDC provider (already present in this account; created only if missing)
PROVIDER_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  echo "Creating GitHub OIDC provider"
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com >/dev/null
fi

# --- AWS: deploy role, trusted only by this repo's `production` environment
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "Updating trust policy of $ROLE"
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document file://deploy/github-oidc-trust-policy.json
else
  echo "Creating role $ROLE"
  aws iam create-role --role-name "$ROLE" --max-session-duration 3600 \
    --description "GitHub Actions ($REPO, production env): push to ECR atlas-chatbot, deploy to the Atlas EC2 instance via SSM" \
    --assume-role-policy-document file://deploy/github-oidc-trust-policy.json >/dev/null
fi
echo "Setting permissions (ECR push to atlas-chatbot, SSM Run Command on $INSTANCE_ID only)"
aws iam put-role-policy --role-name "$ROLE" --policy-name ecr-push-and-ssm-deploy \
  --policy-document file://deploy/github-deploy-policy.json
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

# --- GitHub: `production` environment that only main and v* tags may deploy from
echo "Configuring GitHub environment '$ENV'"
gh api -X PUT "repos/$REPO/environments/$ENV" --input - >/dev/null <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
EXISTING=$(gh api "repos/$REPO/environments/$ENV/deployment-branch-policies" --jq '.branch_policies[] | "\(.type):\(.name)"')
grep -qx "branch:main" <<<"$EXISTING" || gh api -X POST "repos/$REPO/environments/$ENV/deployment-branch-policies" -f name=main -f type=branch >/dev/null
grep -qx "tag:v\*"     <<<"$EXISTING" || gh api -X POST "repos/$REPO/environments/$ENV/deployment-branch-policies" -f name='v*' -f type=tag >/dev/null

PUBLIC_IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

gh secret   set AWS_DEPLOY_ROLE_ARN --repo "$REPO" --env "$ENV" --body "$ROLE_ARN"
gh variable set EC2_INSTANCE_ID     --repo "$REPO" --env "$ENV" --body "$INSTANCE_ID"
gh variable set APP_URL             --repo "$REPO" --env "$ENV" --body "http://$PUBLIC_IP/"

echo
echo "Done. Role: $ROLE_ARN"
echo "Every push to main (or tag v*) now tests, builds, pushes to ECR and deploys to $INSTANCE_ID."
