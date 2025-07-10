/**
 * Memory-safe stream handling utilities to prevent excessive memory usage
 */
const stream = require('stream');
const zlib = require('zlib');

/**
 * Create a memory-safe decompression stream that limits chunk sizes
 * and provides better error handling
 */
function createDecompressionStream(format = 'zlib', options = {}) {
  const maxChunkSize = options.maxChunkSize || (1024 * 1024); // 1MB default
  let decompressor;
  
  // Create the appropriate decompressor
  switch(format) {
    case 'gzip':
      decompressor = zlib.createGunzip();
      break;
    case 'raw':
      decompressor = zlib.createInflateRaw();
      break;
    case 'zlib':
    default:
      decompressor = zlib.createInflate();
  }
  
  // Create a transform stream that manages chunk sizes
  const chunkManager = new stream.Transform({
    transform(chunk, encoding, callback) {
      // If the incoming chunk is too large, break it down
      if (chunk.length > maxChunkSize) {
        for (let i = 0; i < chunk.length; i += maxChunkSize) {
          const end = Math.min(i + maxChunkSize, chunk.length);
          this.push(chunk.slice(i, end));
        }
      } else {
        this.push(chunk);
      }
      callback();
    }
  });
  
  // Pipe through the chunk manager
  return decompressor.pipe(chunkManager);
}

/**
 * Decompress a buffer using streams and collect the result
 * @param {Buffer} buffer - The compressed buffer to decompress
 * @param {string} format - The format ('zlib', 'gzip', or 'raw')
 * @return {Promise<Buffer>} - The decompressed buffer
 */
function decompressBuffer(buffer, format = 'zlib') {
  return new Promise((resolve, reject) => {
    // Create the decompression stream
    const decompressionStream = createDecompressionStream(format);
    
    // Collect chunks
    const chunks = [];
    let totalLength = 0;
    
    // Handle data chunks
    decompressionStream.on('data', (chunk) => {
      chunks.push(chunk);
      totalLength += chunk.length;
    });
    
    // Handle completion
    decompressionStream.on('end', () => {
      try {
        const result = Buffer.concat(chunks, totalLength);
        resolve(result);
      } catch (err) {
        reject(new Error(`Error combining decompressed chunks: ${err.message}`));
      }
    });
    
    // Handle errors
    decompressionStream.on('error', (err) => {
      reject(new Error(`Decompression error: ${err.message}`));
    });
    
    // Feed data
    const sourceStream = new stream.PassThrough();
    sourceStream.end(buffer);
    sourceStream.pipe(decompressionStream);
  });
}

/**
 * Try multiple decompression formats until one works
 */
async function tryDecompressionFormats(buffer) {
  // Try formats in this order (most likely to least likely)
  const formats = ['zlib', 'raw', 'gzip'];
  
  let lastError = null;
  
  for (const format of formats) {
    try {
      return await decompressBuffer(buffer, format);
    } catch (err) {
      lastError = err;
      // Continue to next format
    }
  }
  
  // If we get here, all formats failed
  throw new Error(`All decompression formats failed: ${lastError.message}`);
}

module.exports = {
  createDecompressionStream,
  decompressBuffer,
  tryDecompressionFormats
};
