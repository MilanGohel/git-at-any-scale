#!/usr/bin/env bun
/**
 * CLI Utility for Managing Git Server Authentication, Users, and Tokens (Phase 11).
 *
 * Usage:
 *   bun run src/scripts/manage-auth.ts add-user <username> [--admin]
 *   bun run src/scripts/manage-auth.ts create-token <username> --name "My Token" [--scopes read,write] [--days 90]
 *   bun run src/scripts/manage-auth.ts revoke-token <username> <tokenId>
 *   bun run src/scripts/manage-auth.ts list-users
 *   bun run src/scripts/manage-auth.ts set-repo <repoId> --owner <username> [--private|--public]
 *   bun run src/scripts/manage-auth.ts list-repos
 */

import { AwsS3Storage } from "../storage/aws-s3";
import { MockR2Storage } from "../storage/mock-r2";
import { AuthStore } from "../auth/auth-store";
import type { R2StorageInterface } from "../types/storage";
import type { TokenScope } from "../types/auth";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

// Initialize Storage: AWS S3 or Local Mock
function getStorage(): R2StorageInterface {
  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "eu-north-1";

  if (bucketName) {
    return new AwsS3Storage({ bucketName, region });
  }

  console.log(`${C.yellow}⚠ Warning: AWS_S3_BUCKET not set. Running against temporary Mock storage.${C.reset}\n`);
  return new MockR2Storage();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const storage = getStorage();
  const authStore = new AuthStore(storage);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "add-user": {
      const username = args[1];
      if (!username) {
        console.error(`${C.red}Error: Missing username. Usage: add-user <username> [--admin]${C.reset}`);
        process.exit(1);
      }
      const isAdmin = args.includes("--admin");
      const user = await authStore.createUser(username, isAdmin ? "admin" : "user");
      console.log(`${C.green}✔ User '${user.username}' created successfully! Role: ${user.role}${C.reset}`);
      break;
    }

    case "create-token": {
      const username = args[1];
      if (!username) {
        console.error(`${C.red}Error: Missing username. Usage: create-token <username> --name <name> [--scopes read,write] [--days 90]${C.reset}`);
        process.exit(1);
      }

      const nameIdx = args.indexOf("--name");
      const tokenName = nameIdx !== -1 && args[nameIdx + 1] ? args[nameIdx + 1]! : "Personal Token";

      const scopesIdx = args.indexOf("--scopes");
      const scopes: TokenScope[] = scopesIdx !== -1 && args[scopesIdx + 1]
        ? (args[scopesIdx + 1]!.split(",") as TokenScope[])
        : ["read", "write"];

      const daysIdx = args.indexOf("--days");
      const days = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1]!, 10) : undefined;

      const { rawToken, token } = await authStore.createTokenForUser({
        username,
        tokenName,
        scopes,
        expiresInDays: days,
      });

      console.log(`\n================================================================================`);
      console.log(`${C.green}${C.bold} 🎉 PERSONAL ACCESS TOKEN GENERATED FOR '${username}'${C.reset}`);
      console.log(`================================================================================`);
      console.log(`  Token ID:   ${token.id}`);
      console.log(`  Name:       ${token.name}`);
      console.log(`  Scopes:     ${token.scopes.join(", ")}`);
      console.log(`  Expires:    ${token.expiresAt || "Never"}`);
      console.log(`\n  ${C.yellow}${C.bold}Secret Token (Save this! It will NOT be shown again):${C.reset}`);
      console.log(`  ${C.cyan}${C.bold}${rawToken}${C.reset}\n`);
      console.log(`Usage with Git CLI:`);
      console.log(`  git clone https://${username}:${rawToken}@<server-host>/<repo>.git`);
      console.log(`================================================================================\n`);
      break;
    }

    case "revoke-token": {
      const username = args[1];
      const tokenId = args[2];
      if (!username || !tokenId) {
        console.error(`${C.red}Error: Usage: revoke-token <username> <tokenId>${C.reset}`);
        process.exit(1);
      }
      const success = await authStore.revokeToken(username, tokenId);
      if (success) {
        console.log(`${C.green}✔ Token '${tokenId}' revoked for user '${username}'.${C.reset}`);
      } else {
        console.error(`${C.red}Token '${tokenId}' not found for user '${username}'.${C.reset}`);
      }
      break;
    }

    case "list-users": {
      const manifest = await authStore.getManifest();
      const users = Object.values(manifest.users);
      console.log(`\n${C.bold}Registered Users (${users.length}):${C.reset}`);
      for (const u of users) {
        console.log(`\n  ${C.cyan}• ${u.username}${C.reset} [${u.role}] (Created: ${u.createdAt.slice(0, 10)})`);
        if (u.tokens.length === 0) {
          console.log(`    ${C.dim}No active tokens${C.reset}`);
        } else {
          for (const t of u.tokens) {
            console.log(`    - [${t.id}] ${t.name} (${t.scopes.join(",")}) prefix: ${t.tokenPrefix}`);
          }
        }
      }
      console.log("");
      break;
    }

    case "set-repo": {
      const repoId = args[1];
      const ownerIdx = args.indexOf("--owner");
      const owner = ownerIdx !== -1 && args[ownerIdx + 1] ? args[ownerIdx + 1]! : undefined;
      const isPrivate = args.includes("--private");

      if (!repoId || !owner) {
        console.error(`${C.red}Error: Usage: set-repo <repoId> --owner <username> [--private|--public]${C.reset}`);
        process.exit(1);
      }

      const policy = await authStore.setRepoPolicy({
        repoId,
        owner,
        visibility: isPrivate ? "private" : "public",
      });

      console.log(`${C.green}✔ Repository '${policy.repoId}' updated! Owner: '${policy.owner}', Visibility: ${policy.visibility}${C.reset}`);
      break;
    }

    case "list-repos": {
      const manifest = await authStore.getManifest();
      const repos = Object.values(manifest.repos);
      console.log(`\n${C.bold}Configured Repositories (${repos.length}):${C.reset}`);
      for (const r of repos) {
        console.log(`  • ${C.cyan}${r.repoId}${C.reset} (Owner: ${r.owner}, Visibility: ${r.visibility})`);
      }
      console.log("");
      break;
    }

    default:
      console.error(`${C.red}Unknown command: ${command}${C.reset}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
${C.bold}Git Server Auth & Token Management CLI (Phase 11)${C.reset}

${C.bold}Commands:${C.reset}
  add-user <username> [--admin]
      Registers a new user account.

  create-token <username> --name "Key Name" [--scopes read,write,admin] [--days 90]
      Generates a Personal Access Token (PAT) for the user.

  revoke-token <username> <tokenId>
      Revokes an existing access token.

  list-users
      Lists all registered users and their active tokens.

  set-repo <repoId> --owner <username> [--private|--public]
      Sets repository ownership and public/private visibility.

  list-repos
      Lists all configured repository policies.
`);
}

main().catch((err) => {
  console.error(`${C.red}Fatal Error: ${err.message}${C.reset}`);
  process.exit(1);
});
