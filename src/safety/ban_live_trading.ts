/**
 * Hard guardrail: no live trading. Scans env and config for forbidden keys/values
 * and exits the process if any are found.
 */

const FORBIDDEN_ENV_KEYS = [
  "PRIVATE_KEY",
  "PRIVATEKEY",
  "SECRET_KEY",
  "WALLET",
  "WALLET_KEY",
  "MNEMONIC",
  "SIGN",
  "SIGNER",
  "API_SECRET",
  "POLY_CREDENTIALS",
  "POLYMARKET_SECRET",
  "CLOB_API_SECRET",
  "CLOB_API_KEY",
  "PASSPHRASE",
];

const FORBIDDEN_ENV_KEY_SUBSTRINGS = ["_PRIVATE", "_SECRET", "_SIGN", "WALLET", "MNEMONIC"];

/** Config key substrings that must not appear (credentials / signing). */
const FORBIDDEN_CONFIG_KEYS = [
  "privateKey",
  "private_key",
  "secret_key",
  "wallet_key",
  "mnemonic",
  "signer",
  "api_secret",
  "credentials",
];

function scanEnv(): string[] {
  const found: string[] = [];
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase();
    if (FORBIDDEN_ENV_KEYS.some((f) => upper === f || upper.includes(f))) {
      found.push(`ENV key forbidden: ${key}`);
    }
    for (const sub of FORBIDDEN_ENV_KEY_SUBSTRINGS) {
      if (upper.includes(sub)) {
        found.push(`ENV key looks sensitive: ${key}`);
        break;
      }
    }
  }
  return found;
}

function scanObject(obj: unknown, path: string = "config"): string[] {
  const found: string[] = [];
  if (obj === null || typeof obj !== "object") return found;
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = String(k).toLowerCase();
    const fullPath = `${path}.${k}`;
    for (const forbidden of FORBIDDEN_CONFIG_KEYS) {
      if (keyLower.includes(forbidden.toLowerCase())) {
        found.push(`Config has suspicious key: ${fullPath}`);
        break;
      }
    }
    if (typeof v === "string" && /^(0x)?[a-fA-F0-9]{64}$/.test(v)) {
      found.push(`Config has hex-like value at: ${fullPath}`);
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      found.push(...scanObject(v, fullPath));
    }
  }
  return found;
}

/**
 * Call on startup with loaded config. Exits process if any forbidden keys/values found.
 */
export function enforceNoLiveTrading(config: unknown): void {
  const envViolations = scanEnv();
  const configViolations = config ? scanObject(config) : [];
  const all = [...envViolations, ...configViolations];
  if (all.length > 0) {
    console.error("[SAFETY] Live-trading guardrail triggered. Forbidden or suspicious keys found:");
    all.forEach((m) => console.error("  - " + m));
    console.error("[SAFETY] This lab is read-only and paper-trading only. Exiting.");
    process.exit(1);
  }
}
