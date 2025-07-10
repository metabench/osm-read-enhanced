/**
 * Controls logging verbosity throughout the application
 */

// Default verbosity level - 0 for none, 1 for minimal, 2 for detailed, 3 for debug
let verbosityLevel = 0;

// Contextual data for the current operation
let context = {};

/**
 * Set the verbosity level
 * @param {number} level - 0 for none, 1 for minimal, 2 for detailed, 3+ for debug
 */
function setVerbosityLevel(level) {
  verbosityLevel = Math.max(0, Math.min(3, parseInt(level, 10) || 0));
}

/**
 * Set contextual information for logging
 * @param {object} ctx - Context object with relevant information
 */
function setContext(ctx) {
  context = { ...context, ...ctx };
}

/**
 * Log a message at the specified level
 * @param {number} level - Minimum verbosity level at which to log
 * @param {string} message - The message to log
 * @param {any} [data] - Optional data to include with the message
 */
function log(level, message, data) {
  if (verbosityLevel >= level) {
    if (data !== undefined) {
      console.log(`[${getPrefix(level)}] ${message}`, data);
    } else {
      console.log(`[${getPrefix(level)}] ${message}`);
    }
  }
}

/**
 * Get the prefix for the specified verbosity level
 * @private
 */
function getPrefix(level) {
  switch (level) {
    case 0: return 'ERROR'; // Always shown
    case 1: return 'INFO';  // Minimal info
    case 2: return 'DETAIL'; // Detailed operations
    case 3: return 'DEBUG';  // Debug info
    default: return 'TRACE';  // Extra verbose
  }
}

// Convenience methods
const error = (message, data) => log(0, message, data);
const info = (message, data) => log(1, message, data);
const detail = (message, data) => log(2, message, data);
const debug = (message, data) => log(3, message, data);

module.exports = {
  setVerbosityLevel,
  setContext,
  log,
  error,
  info,
  detail,
  debug,
  get level() { return verbosityLevel; }
};
