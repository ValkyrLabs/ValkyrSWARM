#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_API_BASE,
  DEFAULT_CREDENTIAL_FILE,
  DEFAULT_KEYCHAIN_SERVICE,
  DEFAULT_TOKEN_FILE,
  credentialsFromEnvironment,
  loginWithCredentials,
  persistAuthentication,
} from "./swarm-auth.mjs";

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/swarm-login.mjs [options]\n\nOptions:\n  --api-base <url>          Default https://api-0.valkyrlabs.com/v1\n  --keychain-service <name> Default VALKYR_AUTH\n  --token-file <path>       Non-macOS token file\n  --credential-file <path>  Non-macOS mode-0600 credential file\n  --self-test               Validate offline contracts\n\nSet VALKYR_USERNAME and VALKYR_PASSWORD for unattended login. The aliases\nVALKYR_SWARM_USERNAME and VALKYR_SWARM_PASSWORD are also accepted. Secrets are\nstored in macOS Keychain or mode-0600 files and are never printed.\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (!["--api-base", "--keychain-service", "--token-file", "--credential-file"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    const { selfTest } = await import("./swarm-auth.mjs");
    selfTest();
    return;
  }
  const credentials = credentialsFromEnvironment();
  const apiBase = options.apiBase ?? process.env.VALKYR_API_BASE ?? DEFAULT_API_BASE;
  const keychainService = options.keychainService ?? process.env.VALKYR_KEYCHAIN_SERVICE ?? DEFAULT_KEYCHAIN_SERVICE;
  const tokenFile = options.tokenFile ?? process.env.VALKYR_SWARM_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  const credentialFile = options.credentialFile ?? process.env.VALKYR_SWARM_CREDENTIAL_FILE ?? DEFAULT_CREDENTIAL_FILE;
  const token = await loginWithCredentials({ ...credentials, apiBase });
  const stored = persistAuthentication({ token, ...credentials, keychainService, tokenFile, credentialFile });
  process.stdout.write(`${JSON.stringify({ authenticated: true, apiBase, storage: stored.storage, location: stored.location })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Valkyr SWARM login failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { parseArgs };
