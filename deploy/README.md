# Deploying Atlas to EC2

The image contains **no AWS credentials**. On EC2, boto3 gets temporary credentials
from the IAM role attached to the instance (an *instance profile*), through the
instance metadata service. `app.py` needs no changes: it uses boto3's normal
credential lookup, so the same code works on your laptop (`~/.aws`) and on EC2 (role).

Commands below use the AWS CLI. Run them on your own machine unless a step says
"on the instance". The account ID is never hardcoded: step 0 reads it into `AWS_ACCOUNT_ID`.

## Regions: two of them, on purpose

| What | Region |
|---|---|
| ECR repository `atlas-chatbot`, EC2 instance, security group | **`eu-west-2`** (London) |
| Bedrock model calls (`AWS_REGION` baked into the image) | **`us-east-1`** |

The container calls Bedrock in `us-east-1` no matter where it runs, which is why
`deploy/bedrock-invoke-policy.json` names `us-east-1`. Everything else is `eu-west-2`.

---

## 0. Pick your AWS profile, account ID and registry (every shell session)

```bash
export AWS_PROFILE=class            # the profile for the account that owns the instance
export AWS_REGION=eu-west-2         # ECR + EC2 region for the CLI (not the Bedrock region)
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REGISTRY=${AWS_ACCOUNT_ID}.dkr.ecr.eu-west-2.amazonaws.com
```

PowerShell equivalent:

```powershell
$env:AWS_PROFILE = "class"; $env:AWS_REGION = "eu-west-2"
$env:AWS_ACCOUNT_ID = aws sts get-caller-identity --query Account --output text
$env:REGISTRY = "$env:AWS_ACCOUNT_ID.dkr.ecr.eu-west-2.amazonaws.com"
```

## 1. Create the IAM role for the instance (one time)

IAM is global, so these commands don't depend on the region.

```bash
# Role that EC2 is allowed to assume
aws iam create-role --role-name atlas-chatbot-ec2 --assume-role-policy-document file://deploy/ec2-trust-policy.json

# Permission to call only the one Bedrock model the app uses (streaming + non-streaming)
aws iam put-role-policy --role-name atlas-chatbot-ec2 --policy-name bedrock-invoke --policy-document file://deploy/bedrock-invoke-policy.json

# Permission to pull the image from ECR (step 2)
aws iam attach-role-policy --role-name atlas-chatbot-ec2 --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

# Lets you run commands with Session Manager instead of SSH keys (used in step 5)
aws iam attach-role-policy --role-name atlas-chatbot-ec2 --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

# Wrap the role in an instance profile so EC2 can use it
aws iam create-instance-profile --instance-profile-name atlas-chatbot-ec2
aws iam add-role-to-instance-profile --instance-profile-name atlas-chatbot-ec2 --role-name atlas-chatbot-ec2
```

If you switch models, update the model id in `deploy/bedrock-invoke-policy.json`
(all three statements) and run `put-role-policy` again.

## 2. Build and push a versioned image to ECR

Every release gets a version tag (`1.0.0`, `1.1.0`, `1.2.0`, ...) **and** `latest`.
The instance runs a specific version, so you always know what is deployed and can roll back.

```bash
aws ecr create-repository --repository-name atlas-chatbot --region eu-west-2   # first time only
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin $REGISTRY

VERSION=1.2.0   # bump for every release
# Match the instance's CPU: linux/amd64 for t3/m6i etc., linux/arm64 for Graviton (t4g/m7g)
docker buildx build --platform linux/amd64 \
  -t $REGISTRY/atlas-chatbot:$VERSION -t $REGISTRY/atlas-chatbot:latest --push .
```

## 3. Launch (or prepare) the instance

- **Region:** `eu-west-2`. **AMI:** Amazon Linux 2023. **Type:** t3.micro (x86_64, so `linux/amd64` images).
- **IAM instance profile:** `atlas-chatbot-ec2`.
- **Metadata:** IMDSv2 required, with **hop limit 2**. Docker containers sit one network hop
  behind the host, so with a hop limit of 1 boto3 *inside the container* cannot reach the
  metadata service and fails with `NoCredentialsError`. For an existing instance:

  ```bash
  aws ec2 modify-instance-metadata-options --instance-id <INSTANCE_ID> --http-tokens required --http-put-response-hop-limit 2 --http-endpoint enabled
  ```
  To attach the role to an existing instance:
  ```bash
  aws ec2 associate-iam-instance-profile --instance-id <INSTANCE_ID> --iam-instance-profile Name=atlas-chatbot-ec2
  ```
- **Security group:** allow inbound TCP **80** and **8000** (and 22 if you use SSH)
  **from your own IP only** (`<your-ip>/32`). The app is served over plain HTTP, and anyone
  who can reach it can sign up and spend free messages on your Bedrock bill.
  If your IP changes, update the rules or the page stops loading.

## 4. Run the container (on the instance, first time)

```bash
sudo dnf install -y docker && sudo systemctl enable --now docker

REGISTRY=<account-id>.dkr.ecr.eu-west-2.amazonaws.com
VERSION=1.2.0
aws ecr get-login-password --region eu-west-2 | sudo docker login --username AWS --password-stdin $REGISTRY

sudo docker run -d --name atlas --restart unless-stopped \
  -p 80:8000 -p 8000:8000 \
  -v atlas-data:/app/data \
  $REGISTRY/atlas-chatbot:$VERSION
```

Open `http://<instance-public-ip>/` (or `:8000`). Accounts and chat history are kept in the
`atlas-data` Docker volume, so they survive container restarts and image updates.

Settings can be overridden with `-e`, for example
`-e BEDROCK_MODEL_ID=... -e FREE_MESSAGE_LIMIT=20 -e SESSION_COOKIE_SECURE=1` (the last one
only once the site is served over HTTPS). Do not pass AWS keys with `-e`; the role supplies them.

### Check that the role is being used

```bash
sudo docker exec atlas python -c "import boto3; print(boto3.client('sts').get_caller_identity()['Arn'])"
# expected: arn:aws:sts::<account-id>:assumed-role/atlas-chatbot-ec2/i-...
```

## 5. Update to a new version

After pushing a new version (step 2), replace the container on the instance. The data volume is kept.
On the instance (SSH or Session Manager):

```bash
REGISTRY=<account-id>.dkr.ecr.eu-west-2.amazonaws.com
VERSION=1.2.0
aws ecr get-login-password --region eu-west-2 | sudo docker login --username AWS --password-stdin $REGISTRY
sudo docker pull $REGISTRY/atlas-chatbot:$VERSION
sudo docker rm -f atlas
sudo docker run -d --name atlas --restart unless-stopped \
  -p 80:8000 -p 8000:8000 -v atlas-data:/app/data \
  $REGISTRY/atlas-chatbot:$VERSION
```

Or from your machine, without logging in to the instance, using Session Manager
(put the commands above in a JSON file as `{"commands": [ ... ]}`):

```bash
aws ssm send-command --region eu-west-2 --instance-ids <INSTANCE_ID> \
  --document-name AWS-RunShellScript --parameters file://update.json
```

To roll back, run the same commands with the previous `VERSION`.

### Validate

```bash
curl -i http://<instance-public-ip>/api/health        # 200 {"status":"ok",...}
curl -i http://<instance-public-ip>:8000/api/health   # same on port 8000
curl -I http://<instance-public-ip>/                  # 302 to /signin when signed out
```

On the instance, `sudo docker ps` should show the new version and `(healthy)` after about 10 seconds.

---

## Running the image on your own machine

Mount your AWS config read-only and name the profile to use (`~/.aws` has named
profiles, no `default`). Nothing is copied into the image:

```powershell
docker build -t atlas-chatbot .
docker run --rm -p 8000:8000 -e AWS_PROFILE=<your-profile> -v "$env:USERPROFILE\.aws:/home/app/.aws:ro" -v atlas-data:/app/data atlas-chatbot
```

Then open http://localhost:8000.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `RepositoryNotFoundException` | Wrong region or profile. The repo is in `eu-west-2` under the `class` profile's account. |
| `NoCredentialsError` on EC2 | No instance profile attached, or metadata hop limit is 1. See step 3. |
| `AccessDeniedException` | Role policy missing or wrong model id, or model access not enabled in Bedrock (`us-east-1`) for this account. |
| `exec format error` | Image built for the wrong CPU. Rebuild with the matching `--platform`. |
| Page doesn't load | Security group doesn't allow ports 80/8000 from your current IP, or the container stopped (`sudo docker logs atlas`). |
