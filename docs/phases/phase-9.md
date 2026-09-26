# Phase 9: Single-Host Production Deployment on AWS EC2

> **Core Objective:** Package and deploy the Continuity Git engine onto a single AWS EC2 instance, serving standard Git Smart HTTP traffic (`git clone`, `git push`) backed by the durable S3 Write-Ahead Log.

---

## 🏛️ 1. Architecture: Single EC2 Host with S3 Durability

Instead of managing a complex cluster of read replicas, a single-host deployment provides a streamlined, ultra-reliable Git server where **the local EC2 disk is purely an ephemeral cache**, and **AWS S3 is the indestructible source of truth**.

```
                   DEVELOPER WORKSTATION / CI RUNNER
                                   │
                                   │  git push / git clone
                                   │  http://<ec2-public-ip>:3000/:repoId.git
                                   ▼
          ┌────────────────────────────────────────────────────────┐
          │               SINGLE AWS EC2 INSTANCE                  │
          │         (e.g., t4g.small / Ubuntu 24.04)               │
          │                                                        │
          │   ┌────────────────────────────────────────────────┐   │
          │   │      Git HTTP Smart Server (Bun.serve)         │   │
          │   │  - info/refs?service=git-upload-pack (Clone)   │   │
          │   │  - git-upload-pack (Read streaming)           │   │
          │   │  - git-receive-pack (Push ingestion & S3 CAS)  │   │
          │   └───────────────────────┬────────────────────────┘   │
          │                           │                            │
          │                           ▼                            │
          │   ┌────────────────────────────────────────────────┐   │
          │   │   Ephemeral NVMe / EBS Local Cache Directory   │   │
          │   │   /var/git-data/repos/<repoId>.git (Bare Repo) │   │
          │   │   - If cold -> auto-materialize from S3        │   │
          │   │   - If warm -> serve in <5ms                   │   │
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

## 🛡️ 2. The Disaster Recovery Guarantee: "Cattle, Not Pets"

Traditional single-server Git hosting (e.g. self-hosted GitLab or Gitea on EC2) is notoriously fragile:
- If the EBS volume corrupts, commits are lost.
- If the EC2 instance is terminated or resized, the team must restore from backup tapes with hours of downtime.

### How Continuity Changes This:
1. **Zero Data on EC2 is Irreplaceable:** Every single `git push` is acknowledged **only after** the binary `.pack` file and `wal_index.json` are committed to S3 via Atomic Compare-And-Swap (`If-Match`).
2. **Instant Instance Replacement:** If the EC2 instance terminates:
   - Launch a new EC2 instance.
   - Start the service.
   - The first time someone runs `git clone` or `git push`, the server detects an empty disk, runs `materialize()` in ~500ms from S3, and resumes normal operation.
3. **IAM Instance Roles:** No API keys need to be stored on the EC2 server. The instance uses its attached AWS IAM Role to securely access the S3 bucket.

---

## 🔌 3. The Git Smart HTTP Wire Protocol

To allow any standard Git client (`git clone http://...`) to work out-of-the-box, the server implements Git's native **Smart HTTP Transfer Protocol**:

```
                       CLIENT                               SERVER
                         │                                     │
   1. Ref Discovery:     │  GET /repo.git/info/refs?service=.. │
                         │ ──────────────────────────────────> │
                         │ <────────────────────────────────── │ Spawns git-upload-pack
                         │  HTTP 200 (Advertised Refs)         │ (or git-receive-pack)
                         │                                     │
   2. Packfile Transfer: │  POST /repo.git/git-upload-pack     │
                         │ ──────────────────────────────────> │
                         │ <────────────────────────────────── │ Streams Packfile
                         │  HTTP 200 (Binary .pack payload)    │
```

### Route Handling in `src/server/git-http-server.ts`:
- `GET /:repoId.git/info/refs`:
  - Validates repository state against S3 WAL.
  - If the local repository does not exist, materializes it from S3.
  - Executes `git http-backend` or `git upload-pack / receive-pack --advertise-refs`.
- `POST /:repoId.git/git-upload-pack`:
  - Streams repository objects to the client for `git clone` and `git fetch`.
- `POST /:repoId.git/git-receive-pack`:
  - Ingests incoming pushes from the client.
  - Preserves incoming `.pack` files with `receive.unpackLimit = 1`.
  - Streams the new `.pack` to S3 and updates `wal_index.json` via Atomic CAS.

---

## 📦 4. Deployment Methods

### Method A: Docker & Docker Compose (Recommended)
Packaged with Bun and Git into a lightweight alpine/debian container:
```bash
docker compose up -d
```

### Method B: Native Systemd Service (EC2 Bare Host)
Run directly as a background Linux service managed by `systemd`:
```bash
sudo systemctl start git-at-any-scale
sudo systemctl enable git-at-any-scale
```

---

## 🚀 5. Quick EC2 Setup Guide

1. **Launch EC2 Instance:**
   - AMI: **Ubuntu 24.04 LTS** or **Amazon Linux 2023** (ARM64 `t4g.small` or x86 `t3.small`).
   - Security Group: Inbound **TCP Port 3000** (or 80/443), and **TCP Port 22** (SSH).
   - IAM Role: Attach a role with `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` on your bucket.
2. **Clone & Run:**
   ```bash
   git clone https://github.com/MilanGohel/git-at-any-scale.git
   cd git-at-any-scale
   bun install
   bun run serve
   ```
3. **Clone and Push from your laptop:**
   ```bash
   git clone http://<ec2-public-ip>:3000/my-repo.git
   cd my-repo
   touch test.txt && git add . && git commit -m "First commit on EC2"
   git push origin main
   ```
