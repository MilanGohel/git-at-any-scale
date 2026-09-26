# Phase 10: Serverless Architecture on AWS Lambda (Git over Lambda Function URLs & S3)

> **Core Objective:** Migrate the Git hosting engine from dedicated EC2 virtual machines to a 100% Serverless architecture using **AWS Lambda Function URLs**, **AWS Lambda Web Adapter**, and **AWS S3 Write-Ahead Log**, achieving true **$0 idle cost** and automated horizontal scaling.

---

## 🏛️ 1. Why Traditional Git Fails on Serverless (And Why Continuity Thrives)

Traditional Git servers (like GitLab, GitHub Enterprise, or Gitea) **cannot run on serverless**:
1. **Stateful Filesystems:** They assume repositories sit permanently on a mounted local disk.
2. **File Locks & Daemons:** They rely on long-running background processes and POSIX file locks.
3. **Instance Destruction:** When a serverless container is killed, all local data is destroyed.

### The Continuity Breakthrough:
Because Cursor's Continuity architecture treats local disks as **ephemeral, disposable scratch space ("Cattle, Not Pets")** and **AWS S3 as the sole source of truth**:
- It doesn't matter if AWS Lambda terminates the execution environment after 5 minutes.
- The next Lambda container boots up with an empty `/tmp` disk, pulls `wal_index.json` and `.pack` files from S3 in ~300ms using [`materialize()`](file:///home/milan/Milan/Learning/git-at-any-scale/src/engine/replica-node.ts), and serves traffic immediately.
- Concurrent pushes to different Lambda instances are safely serialized without distributed locks via **S3 Atomic Compare-And-Swap (`If-Match`)**.

---

## 🏗️ 2. The Serverless Architecture

```
                    DEVELOPER / CI RUNNER / AI AGENT
                                   │
                                   │  git push / git clone
                                   │  https://<lambda-id>.lambda-url.eu-north-1.on.aws/:repoId.git
                                   ▼
          ┌────────────────────────────────────────────────────────┐
          │      AWS LAMBDA (Serverless Container with Bun)        │
          │                                                        │
          │   ┌────────────────────────────────────────────────┐   │
          │   │   AWS Lambda Web Adapter (aws-lambda-adapter)  │   │
          │   │   - Translates Lambda events into HTTP streams │   │
          │   └───────────────────────┬────────────────────────┘   │
          │                           │                            │
          │                           ▼                            │
          │   ┌────────────────────────────────────────────────┐   │
          │   │      Git HTTP Smart Server (Bun.serve:3000)    │   │
          │   │  - git-upload-pack (Clone/Fetch streaming)     │   │
          │   │  - git-receive-pack (Push ingestion & S3 CAS)  │   │
          │   └───────────────────────┬────────────────────────┘   │
          │                           │                            │
          │                           ▼                            │
          │   ┌────────────────────────────────────────────────┐   │
          │   │         Ephemeral Lambda /tmp Cache            │   │
          │   │         /tmp/repos/<repoId>.git                │   │
          │   │  - Cold start: auto-materialize in ~300ms      │   │
          │   │  - Warm container: serve in <5ms               │   │
          │   └───────────────────────┬────────────────────────┘   │
          └───────────────────────────┼────────────────────────────┘
                                      │
                                      │ 1. Upload .pack on push
                                      │ 2. Atomic CAS on wal_index.json
                                      │ 3. Cold materialization on boot
                                      ▼
                      ┌────────────────────────────────┐
                      │    AWS S3 BUCKET (Durability)  │
                      │                                │
                      │  ├── <repoId>/wal_index.json   │
                      │  └── <repoId>/wal/packs/*.pack │
                      └────────────────────────────────┘
```

---

## ⚡ 3. Key Components of the Serverless Stack

### 1. AWS Lambda Function URLs with Response Streaming
- Traditional API Gateway imposes a strict 10MB payload limit and 29-second timeout, which breaks large `git clone` and `git push` operations.
- **Lambda Function URLs** bypass API Gateway completely:
  - Supports up to **15-minute execution timeouts**.
  - Built-in free **HTTPS endpoint** (`https://<lambda-id>.lambda-url.eu-north-1.on.aws`).
  - Supports **binary streaming of `.pack` files**.

### 2. AWS Lambda Web Adapter (`aws-lambda-adapter`)
- An official open-source extension from AWS (`awslabs/aws-lambda-web-adapter`).
- Allows any standard web server (like our `Bun.serve()` on port 3000) to run inside AWS Lambda without writing complex custom event-handler wrappers.
- It translates incoming Lambda invocations into local HTTP requests, and streams stdout back to the client.

### 3. Ephemeral `/tmp` Storage (512MB – 10GB)
- Configured as the ephemeral repository cache (`GIT_DATA_DIR=/tmp/repos`).
- When a Lambda instance stays warm, subsequent operations for the same repository skip S3 downloads and run with sub-millisecond local speed.
- When Lambda scales to zero, `/tmp` is wiped, incurring **$0 in storage fees**.

---

## 💰 4. Cost Comparison: EC2 vs. Serverless Lambda

| Metric | Single EC2 Host (`t3.small`) | Serverless (AWS Lambda + S3) |
| :--- | :--- | :--- |
| **Idle Cost** | ~$15–$25 / month (24/7 runtime) | **$0.00 / month (Literally $0 when idle)** |
| **Free Tier** | 750 hrs/mo (first 12 months only) | **1M free requests + 3.2M free seconds every month forever** |
| **Scaling Limit** | 1 server CPU / RAM bottleneck | **Auto-scales to thousands of concurrent clones** |
| **Maintenance** | OS updates, SSH keys, security patches | **Zero infrastructure maintenance** |

---

## 🚀 5. Deployment Workflow

1. **Build Container Image:** Package Bun, native Git, and `aws-lambda-adapter` into `Dockerfile.lambda`.
2. **Push to Amazon ECR:** Upload the container image to your private Amazon Elastic Container Registry.
3. **Create Lambda Function:** Configure memory (1024MB), ephemeral storage (`/tmp` 2048MB), and timeout (15 mins).
4. **Enable Function URL:** Configure public auth (`NONE`) with streaming mode enabled.
5. **Attach IAM Policy:** Grant `s3:GetObject`, `s3:PutObject`, and `s3:ListBucket` permissions to the Lambda execution role.
6. **Clone & Push:**
   ```bash
   git clone https://<lambda-url>/:repoId.git
   git push origin main
   ```
