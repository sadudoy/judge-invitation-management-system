'use strict';

/**
 * In-memory sliding window / bucket rate limiter middleware factory.
 * @param {object} options
 * @param {number} options.windowMs Window in milliseconds (default 60,000 = 1 min)
 * @param {number} options.max Maximum requests per window (default 60)
 * @param {string} options.message Error message on limit exceeded
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 60;
  const message = options.message || 'Too many requests, please try again later.';
  const hits = new Map();

  // Periodic cleanup every 2 minutes
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of hits.entries()) {
      if (now - record.resetTime > 0) {
        hits.delete(key);
      }
    }
  }, Math.max(windowMs * 2, 60000));
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  return function rateLimiter(req, res, next) {
    // In test environment or disabled, allow bypass if explicitly configured
    if (process.env.DISABLE_RATE_LIMIT === 'true') {
      return next();
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `${ip}:${req.baseUrl || req.path}`;
    const now = Date.now();

    let record = hits.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      hits.set(key, record);
    } else {
      record.count += 1;
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000));

    if (record.count > max) {
      return res.status(429).json({
        error: message,
        retryAfterMs: record.resetTime - now,
      });
    }

    next();
  };
}

module.exports = {
  createRateLimiter,
};
