/**
 * Sharflow — OAuth Token Encryption Utility
 *
 * Provides AES-256-GCM authenticated encryption for sensitive OAuth refresh tokens.
 * Derives a 32-byte key from OAUTH_TOKEN_ENCRYPTION_KEY using SHA-256.
 * Refresh tokens are NEVER stored in plain text and NEVER exposed to frontend clients.
 */

const crypto = require("crypto");

function getKey() {
  const rawKey = (process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!rawKey) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY environment variable is missing.");
  }
  return crypto.createHash("sha256").update(rawKey).digest();
}

function hasEncryptionKey() {
  return Boolean((process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "").trim());
}

/**
 * Encrypts sensitive string using AES-256-GCM.
 * @param {string} text - Plaintext token
 * @returns {string} Encrypted format "iv:authTag:ciphertext"
 */
function encryptToken(text) {
  if (!text) return "";
  const key = getKey();
  const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM encrypted token.
 * @param {string} encryptedBlob - Format "iv:authTag:ciphertext"
 * @returns {string} Plaintext token
 */
function decryptToken(encryptedBlob) {
  if (!encryptedBlob) return "";
  const parts = String(encryptedBlob).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token structure");
  }
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getKey();
  
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

module.exports = {
  encryptToken,
  decryptToken,
  hasEncryptionKey,
};
