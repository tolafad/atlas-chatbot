# Deploying Atlas to EC2

The image contains **no AWS credentials**. On EC2, boto3 gets temporary credentials
from the IAM role attached to the instance (an *instance profile*), through the
instance metadata service. `app.py` needs no changes: it uses boto3's normal
credential lookup, so the same code works on your laptop (`~/.aws`) and on EC2 (role).

Commands below use the AWS CLI. Run them on your own machine unless a step says
"on the instance". The account ID is never hardcoded: step 0 reads it into `AWS_ACCOUNT_ID`, region `us-east-1`.

---

## 0. Pick your AWS profile and account ID (every shell session)

```bash
export AWS_PROFILE=<your-profile>   # a profile name from ~/.aws/config
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

## 1. Create the IAM role for the instance (one time)

```bash
# Role that EC2 is allowed to assume
aws iam create-role --role-name atlas-chatbot-ec2 --assume-role-policy-document file://deploy/ec2-trust-policy.json

# Permission to call only the one Bedrock model the app uses (streaming + non-streaming)
aws iam put-role-policy --role-name atlas-chatbot-ec2 --policy-name bedrock-invoke --policy-document file://deploy/bedrock-invoke-policy.json

# Permission to pull the image from ECR (step 2)
aws iam attach-role-policy --role-name atlas-chatbot-ec2 --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

# Optional: lets you open a shell with Session Manager instead of SSH keys
aws iam attach-role-policy --role-name atlas-chatbot-ec2 --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

# Wrap the role in an instance profile so EC2 can use it
aws iam create-instance-profile --instance-profile-name atlas-chatbot-ec2
aws iam add-role-to-instance-profile --instance-profile-name atlas-chatbot-ec2 --role-name atlas-chatbot-ec2
```

If you switch models, update the model id in `deploy/bedrock-invoke-policy.json`
(all three statements) and run `put-role-policy` again.

## 2. Push the image to ECR

```bash
aws ecr create-repository --repository-name atlas-chatbot --region us-east-1
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com

# Match the instance's CPU: linux/amd64 for t3/m6i etc., linux/arm64 for Graviton (t4g/m7g)
docker buildx build --platform linux/amd64 -t ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/atlas-chatbot:latest --push .
```

## 3. Launch (or prepare) the instance

- **AMI:** Amazon Linux 2023.
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
- **Security group:** allow inbound TCP 80 **from your own IP only** (`<your-ip>/32`).
  The app has no login yet, so anyone who can reach it can read and delete chats and
  run up Bedrock charges.

## 4. Run the container (on the instance)

```bash
sudo dnf install -y docker && sudo systemctl enable --now docker

aws ecr get-login-password --region us-east-1 | sudo docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com

sudo docker run -d --name atlas --restart unless-stopped \
  -p 80:8000 \
  -v atlas-data:/app/data \
  ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/atlas-chatbot:latest
```

Open `http://<instance-public-ip>/`. Chat history is kept in the `atlas-data` Docker volume,
so it survives container restarts and image updates.

Settings can be overridden with `-e`, for example
`-e BEDROCK_MODEL_ID=... -e BEDROCK_MAX_TOKENS=1024`. Do not pass AWS keys with `-e`;
the role supplies them.

### Check that the role is being used

```bash
sudo docker exec atlas python -c "import boto3; print(boto3.client('sts').get_caller_identity()['Arn'])"
# expected: arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/atlas-chatbot-ec2/i-...
```

### Update to a new image

```bash
sudo docker pull ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/atlas-chatbot:latest
sudo docker rm -f atlas
# then repeat the docker run command above
```

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
| `NoCredentialsError` on EC2 | No instance profile attached, or metadata hop limit is 1. See step 3. |
| `AccessDeniedException` | Role policy missing or wrong model id, or model access not enabled in Bedrock for this account. |
| `exec format error` | Image built for the wrong CPU. Rebuild with the matching `--platform`. |
| Page doesn't load | Security group doesn't allow port 80 from your IP, or the container stopped (`sudo docker logs atlas`). |
