'use strict';

const crypto = require('crypto');

/**
 * Generate a cryptographically secure random token (32 bytes, base64url encoded).
 * Yields 256 bits of entropy.
 */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash a raw token with SHA-256 for database storage and indexed lookup.
 * @param {string} token
 * @returns {string} hex-encoded SHA-256 hash
 */
function hashToken(token) {
  if (typeof token !== 'string' || !token) {
    throw new TypeError('Token must be a non-empty string');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare two hex strings in constant time to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  generateToken,
  hashToken,
  timingSafeEqual,
};
