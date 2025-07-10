/**
 * Simple direct decompression utility
 * Used as a fallback when worker threads have issues
 */
const zlib = require('zlib');
const util = require('util');

// Create promisified versions of zlib functions
const inflateAsync = util.promisify(zlib.inflate);
const inflateRawAsync = util.promisify(zlib.inflateRaw);
const gunzipAsync = util.promisify(zlib.gunzip);

/**
 * Attempts to decompress data using multiple formats if needed
 * @param {Buffer} data - The compressed data
 * @param {string} [preferredFormat='zlib'] - The preferred format to try first
 * @returns {Promise<Object>} - The decompressed data and stats
 */
async function decompressWithFallback(data, preferredFormat = 'zlib') {
  // Validate inputs
  if (!data || data.length === 0) {
    throw new Error('No data provided for decompression');
  }
  
  // Order of formats to try
  const formatOrder = [preferredFormat];
  ['zlib', 'raw', 'gzip'].forEach(format => {
    if (!formatOrder.includes(format)) {
      formatOrder.push(format);
    }
  });
  
  // Try each format
  let lastError = null;
  for (const format of formatOrder) {
    try {
      let result;
      switch (format) {
        case 'zlib':
          result = await inflateAsync(data);
          break;
        case 'raw':
          result = await inflateRawAsync(data);
          break;
        case 'gzip':
          result = await gunzipAsync(data);
          break;
        default:
          throw new Error(`Unknown format: ${format}`);
      }
      
      return {
        decompressedData: result,
        length: result.length,
        format
      };
    } catch (err) {
      lastError = err;
      console.log(`Decompression with ${format} failed: ${err.message}`);
      // Continue to next format
    }
  }
  
  // If we get here, all formats failed
  throw new Error(`Decompression failed with all formats: ${lastError.message}`);
}

/**
 * Detects the most likely compression format
 * @param {Buffer} data - The data to analyze
 * @returns {string} - The detected format ('zlib', 'gzip', or 'raw')
 */
function detectFormat(data) {
  if (!data || data.length < 2) {
    return 'raw';
  }
  
  // Check for zlib header
  if (data[0] === 0x78 && (data[1] === 0x01 || data[1] === 0x9C || data[1] === 0xDA)) {
    return 'zlib';
  }
  
  // Check for gzip header
  if (data[0] === 0x1F && data[1] === 0x8B) {
    return 'gzip';
  }
  
  // Default to raw
  return 'raw';
}

module.exports = {
  decompressWithFallback,
  detectFormat,
  inflateAsync,
  inflateRawAsync,
  gunzipAsync
};
