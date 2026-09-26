#!/usr/bin/env bash
# ==============================================================================
# Automated Serverless Deployment Script for AWS Lambda & S3
# Deploys Git at Any Scale to AWS Lambda with Function URL & Response Streaming
# ==============================================================================

set -euo pipefail

echo "================================================================================"
echo " 🚀 DEPLOYING GIT AT ANY SCALE TO AWS LAMBDA (SERVERLESS)"
echo "================================================================================"

# Load environment variables from .env (stripping any accidental spaces around '=')
if [ -f .env ]; then
  eval "$(sed 's/[[:space:]]*=[[:space:]]*/=/g' .env | grep -v '^#' | sed 's/^/export /')"
fi

REGION="${AWS_REGION:-eu-north-1}"
BUCKET="${AWS_S3_BUCKET:-git-at-any-scale}"
APP_NAME="git-at-any-scale"
ECR_REPO_NAME="git-at-any-scale-lambda"
FUNCTION_NAME="git-at-any-scale"
ROLE_NAME="git-at-any-scale-lambda-role"

echo "Configuration:"
echo "  - AWS Region:   $REGION"
echo "  - S3 Bucket:    $BUCKET"
echo "  - Function:     $FUNCTION_NAME"

# 1. Fetch AWS Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "  - AWS Account:  $ACCOUNT_ID"

ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO_NAME"

# 2. Create ECR repository if it doesn't exist
echo -e "\n[1/6] Ensuring Amazon ECR repository exists..."
aws ecr describe-repositories --repository-names "$ECR_REPO_NAME" --region "$REGION" > /dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$ECR_REPO_NAME" --region "$REGION" > /dev/null

# 3. Log in to Amazon ECR
echo -e "\n[2/6] Authenticating Docker to Amazon ECR..."
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# 4. Build and push Docker image
echo -e "\n[3/6] Building and pushing container image (Bun + Git + Lambda Adapter)..."
docker build -f Dockerfile.lambda -t "$ECR_REPO_NAME:latest" .
docker tag "$ECR_REPO_NAME:latest" "$ECR_URI:latest"
docker push "$ECR_URI:latest"

# 5. Create or verify IAM execution role
echo -e "\n[4/6] Configuring IAM Execution Role ($ROLE_NAME)..."
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}'

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text 2>/dev/null || true)

if [ -z "$ROLE_ARN" ]; then
  ROLE_ARN=$(aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY" --query 'Role.Arn' --output text)
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  
  # Allow access to S3 bucket
  S3_POLICY="{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:ListBucket\", \"s3:DeleteObject\"],
        \"Resource\": [\"arn:aws:s3:::$BUCKET\", \"arn:aws:s3:::$BUCKET/*\"]
      }
    ]
  }"
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "S3WALAccessPolicy" --policy-document "$S3_POLICY"
  echo "  - Created IAM Role: $ROLE_ARN"
  sleep 10 # Wait for IAM propagation
else
  echo "  - IAM Role exists: $ROLE_ARN"
fi

# 6. Deploy or update Lambda Function
echo -e "\n[5/6] Deploying AWS Lambda function..."
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" > /dev/null 2>&1; then
  echo "  - Updating existing function code..."
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --image-uri "$ECR_URI:latest" \
    --region "$REGION" > /dev/null
else
  echo "  - Creating new function..."
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --package-type Image \
    --code ImageUri="$ECR_URI:latest" \
    --role "$ROLE_ARN" \
    --timeout 900 \
    --memory-size 1024 \
    --ephemeral-storage Size=2048 \
    --environment "Variables={AWS_S3_BUCKET=$BUCKET,AWS_REGION=$REGION,PORT=3000,AWS_LWA_PORT=3000,GIT_DATA_DIR=/tmp/repos}" \
    --region "$REGION" > /dev/null
fi

echo "  - Waiting for function update to finish..."
aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION" 2>/dev/null || true

# 7. Configure Lambda Function URL
echo -e "\n[6/6] Configuring Lambda Function URL (Public HTTPS endpoint)..."
FUNCTION_URL=$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" --query 'FunctionUrl' --output text 2>/dev/null || true)

if [ -z "$FUNCTION_URL" ]; then
  FUNCTION_URL=$(aws lambda create-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type NONE \
    --region "$REGION" \
    --query 'FunctionUrl' --output text)

  aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    --region "$REGION" > /dev/null 2>&1 || true
fi

echo ""
echo "================================================================================"
echo " 🎉 SERVERLESS DEPLOYMENT SUCCESSFUL!"
echo "================================================================================"
echo "  - Lambda Function URL: $FUNCTION_URL"
echo ""
echo "You can now clone and push directly over HTTPS to your serverless Git platform:"
echo "  git clone ${FUNCTION_URL}my-serverless-repo.git"
echo "  git push origin main"
echo ""
echo "Idle Cost: \$0.00 / month (No servers running!)"
echo "================================================================================"
