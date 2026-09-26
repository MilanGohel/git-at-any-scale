# Phase 11: Authentication & Access Control (Tokens, Basic Auth & Namespaces)

> Securing the serverless Git hosting engine with **Personal Access Tokens (PATs)**, **HTTP Basic Authentication**, Argon2id password hashing, and **multi-tenant repository namespaces** (`/:owner/:repo.git`).

---

## 🎯 Architecture Overview

```
                          CLIENT (Developer / CI)
                                     │
           1. git push / git clone   │
       (Authorization: Basic <base64>)
                                     ▼
                     ┌───────────────────────────────┐
                     │   Git Smart HTTP Server       │
                     │  (AWS Lambda / Bun Server)    │
                     └───────────────┬───────────────┘
                                     │
                 2. Extract username & rawToken
                                     ▼
                     ┌───────────────────────────────┐
                     │         TokenManager          │
                     │  (Argon2id Hash Verification) │
                     └───────────────┬───────────────┘
                                     │
                 3. Load policy via ETag (304 / 200)
                                     ▼
      ┌─────────────────────────────────────────────────────────────┐
      │                    AuthStore on S3 / R2                     │
      │                                                             │
      │  _auth/auth_manifest.json                                   │
      │    - Users & Argon2id Hashes                                │
      │    - Scopes: ["read", "write", "admin"]                     │
      │    - Repository Policies (public / private / owner)         │
      └─────────────────────────────────────────────────────────────┘
                                     │
           4. Authorized (200 OK)    │   401 Unauthorized /
              Proceed to Git CGI     │   403 Forbidden
```

---

## 🔐 Core Capabilities

### 1. Personal Access Tokens (PATs)
- **Token Format:** `pat_<48-hex-chars>` (e.g. `pat_8a9f2c...`).
- **Cryptographic Security:** Raw tokens are never stored in plaintext. Tokens are hashed using **Argon2id** (`Bun.password.hash(rawToken, { algorithm: "argon2id" })`).
- **Granular Scopes:**
  - `read`: Allows `git clone` and `git fetch` on private repositories.
  - `write`: Allows `git push` on owned or collaborated repositories (implies `read`).
  - `admin`: Full administrative access.
- **Expiration:** Optional expiration timeframes (`expiresInDays`), automatically rejecting expired tokens.

### 2. Standard Git HTTP Basic Authentication
When an unauthenticated request attempts to access a protected repository:
1. Server returns `HTTP 401 Unauthorized` with:
   ```http
   WWW-Authenticate: Basic realm="Continuity Git Server"
   ```
2. The standard Git CLI automatically prompts for Username and Password, or resolves credentials from the OS credential helper (`git-credential-osxkeychain`, `git-credential-manager`, or `~/.git-credentials`).
3. Subsequent requests include:
   ```http
   Authorization: Basic bWlsYW46cGF0XzFhMmIzYzRk...
   ```
4. The server decodes credentials, validates the hash in `AuthStore`, and enforces read/write permissions.

### 3. Multi-Tenant Namespaces & Access Control
- **Path Support:** Supports both `/:repo.git` (e.g. `lambda-demo.git`) and scoped multi-tenant paths `/:owner/:repo.git` (e.g. `milan/ondc-scrapper.git`).
- **Repository Visibility:**
  - `public`: Anyone can `git clone` or `git fetch` without credentials. Pushing requires valid credentials with `write` scope.
  - `private`: Both cloning and pushing strictly require authentication and repository ownership or collaborator access.
- **Automatic Ownership:** When an authenticated user pushes to a new repository for the first time, ownership is automatically registered to that user.

### 4. S3 Atomic CAS Persistence
- All users, token hashes, and repository policies are persisted in S3 under `_auth/auth_manifest.json`.
- State transitions are executed with **Atomic CAS (`If-Match`)**, guaranteeing race-free consistency across multiple concurrent Lambda containers without requiring a separate database.

---

## 🛠️ Admin CLI Utility (`manage-auth.ts`)

Manage users, tokens, and repo visibility directly from the terminal:

### 1. Register a User Account
```bash
bun run src/scripts/manage-auth.ts add-user milan --admin
```

### 2. Generate a Personal Access Token
```bash
bun run src/scripts/manage-auth.ts create-token milan --name "Laptop CLI" --scopes read,write --days 90
```
Output:
```
================================================================================
 🎉 PERSONAL ACCESS TOKEN GENERATED FOR 'milan'
================================================================================
  Token ID:   tok_7b19a4
  Name:       Laptop CLI
  Scopes:     read, write
  Expires:    2026-12-26T01:25:00.000Z

  Secret Token (Save this! It will NOT be shown again):
  pat_e4f8b2d1c9a03e67f51b9204...
================================================================================
```

### 3. Set Repository Visibility (Public vs. Private)
```bash
# Make repository private and assign owner
bun run src/scripts/manage-auth.ts set-repo my-private-repo --owner milan --private

# Make repository public
bun run src/scripts/manage-auth.ts set-repo my-open-repo --owner milan --public
```

### 4. List Users and Tokens
```bash
bun run src/scripts/manage-auth.ts list-users
bun run src/scripts/manage-auth.ts list-repos
```

---

## 🧪 Verification & Automated Test Suite

Run the automated test suite with Bun:
```bash
bun test src/tests/auth.test.ts
```

Output:
```
✓ Phase 11 > TokenManager Unit Tests > should generate a secure raw token and valid Argon2id hash [79ms]
✓ Phase 11 > TokenManager Unit Tests > should reject expired tokens [29ms]
✓ Phase 11 > TokenManager Unit Tests > should correctly validate scopes [73ms]
✓ Phase 11 > AuthStore Persistence & Access Control > should manage users, tokens, and repo policies in storage with Atomic CAS [75ms]
✓ Phase 11 > Native Git CLI Integration Tests > should enforce authentication for private repositories and allow authorized Git pushes [383ms]
✓ Phase 11 > Native Git CLI Integration Tests > should support multi-tenant namespace paths (e.g. milan/project-x.git) [165ms]

 6 pass
 0 fail
Ran 6 tests across 1 file. [890ms]
```
