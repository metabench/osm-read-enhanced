/**
 * Compression diagnostic utility for analyzing and debugging PBF data decompression issues
 */
const fs = require('fs');
const zlib = require('zlib');

/**
 * Analyze a buffer to determine its compression type and validate it
 * @param {Buffer} buffer - The buffer to analyze
 * @returns {Object} Diagnostic information
 */
function analyzeCompressionFormat(buffer) {
  const result = {
    length: buffer.length,
    possibleFormats: [],
    recommendedFormat: null,
    headerBytes: buffer.length >= 16 ? buffer.slice(0, 16).toString('hex') : null,
    validZlib: false,
    validGzip: false,
    validRaw: false
  };
  
  // Check zlib format
  if (buffer.length >= 2 && buffer[0] === 0x78) {
    const zlibMarkers = [0x01, 0x9C, 0xDA, 0x5E];
    if (zlibMarkers.includes(buffer[1])) {
      // Check header checksum
      const cmf = buffer[0];
      const flg = buffer[1]; 
      const headerValid = ((cmf * 256 + flg) % 31 === 0);
      
      result.possibleFormats.push('zlib');
      result.validZlib = headerValid;
      
      if (headerValid) {
        result.zlibDetails = {
          compressionMethod: cmf & 0xF, // Lower 4 bits - should be 8 for DEFLATE
          compressionInfo: (cmf >> 4) & 0xF, // Upper 4 bits - window size
          fcheck: flg & 0x1F, // Lower 5 bits - check bits
          fdict: (flg >> 5) & 0x1, // Bit 5 - preset dictionary flag
          flevel: (flg >> 6) & 0x3 // Upper 2 bits - compression level
        };
      }
    }
  }
  
  // Check gzip format
  if (buffer.length >= 3 && buffer[0] === 0x1F && buffer[1] === 0x8B && buffer[2] === 0x08) {
    result.possibleFormats.push('gzip');
    result.validGzip = true;
    
    if (buffer.length >= 10) {
      result.gzipDetails = {
        compressionMethod: buffer[2], // Should be 8 for DEFLATE
        flags: buffer[3],
        mtime: buffer.readUInt32LE(4),
        extraFlags: buffer[8],
        os: buffer[9]
      };
    }
  }
  
  // Check if it might be raw deflate data
  // This is harder to detect reliably, but we can look for typical DEFLATE bit patterns
  if (buffer.length >= 1) {
    const firstByte = buffer[0];
    const bfinal = firstByte & 0x1; // Final block flag
    const btype = (firstByte >> 1) & 0x3; // Block type (0=uncompressed, 1=fixed, 2=dynamic)
    
    if (btype <= 2) { // Valid block types
      result.possibleFormats.push('raw');
      result.rawDetails = { bfinal, btype };
      result.validRaw = true; // Note: This is just a guess
    }
  }
  
  // Choose recommended format
  if (result.validZlib) {
    result.recommendedFormat = 'zlib';
  } else if (result.validGzip) {
    result.recommendedFormat = 'gzip';
  } else if (result.validRaw) {
    result.recommendedFormat = 'raw';
  } else {
    result.recommendedFormat = 'unknown';
  }
  
  return result;
}

/**
 * Try to decompress using all available formats and report results
 * @param {Buffer} buffer - The buffer to test decompress
 * @returns {Object} Test results for each format
 */
function testDecompression(buffer) {
  const results = {
    zlib: { success: false, error: null, bytesDecompressed: 0, time: 0 },
    gzip: { success: false, error: null, bytesDecompressed: 0, time: 0 },
    raw: { success: false, error: null, bytesDecompressed: 0, time: 0 }
  };
  
  // Helper for testing a specific format
  const testFormat = (format, decompressFunction) => {
    const start = Date.now();
    try {
      const decompressed = zlib[decompressFunction](buffer);
      results[format].success = true;
      results[format].bytesDecompressed = decompressed.length;
      results[format].time = Date.now() - start;
    } catch (err) {
      results[format].success = false;
      results[format].error = err.message;
      results[format].time = Date.now() - start;
    }
  };
  
  // Test synchronous decompression first
  try { testFormat('zlib', 'inflateSync'); } catch (e) { results.zlib.error = e.message; }
  try { testFormat('gzip', 'gunzipSync'); } catch (e) { results.gzip.error = e.message; }
  try { testFormat('raw', 'inflateRawSync'); } catch (e) { results.raw.error = e.message; }
  
  // Find best format
  if (results.zlib.success) {
    results.bestFormat = 'zlib';
    results.bestSize = results.zlib.bytesDecompressed;
  } else if (results.gzip.success) {
    results.bestFormat = 'gzip';
    results.bestSize = results.gzip.bytesDecompressed;
  } else if (results.raw.success) {
    results.bestFormat = 'raw';
    results.bestSize = results.raw.bytesDecompressed;
  } else {
    results.bestFormat = null;
    results.bestSize = 0;
  }
  
  return results;
}

/**
 * Create diagnostic function for a decompression issue
 * @param {Buffer} data - The data that failed to decompress
 * @param {string} format - The format that was attempted
 * @param {string} errorMessage - The error message received
 */
function diagnoseDecompressionIssue(data, format, errorMessage) {
  console.log('=== Decompression Diagnostic Report ===');
  console.log(`Original Format: ${format}`);
  console.log(`Error Message: ${errorMessage}`);
  console.log(`Data Length: ${data.length} bytes`);
  
  // Format analysis
  const analysis = analyzeCompressionFormat(data);
  console.log('\n--- Format Analysis ---');
  console.log(`Possible Formats: ${analysis.possibleFormats.join(', ') || 'none detected'}`);
  console.log(`Recommended Format: ${analysis.recommendedFormat}`);
  console.log(`Header Bytes (hex): ${analysis.headerBytes}`);
  
  console.log('\nFormat Validity:');
  console.log(`- Zlib: ${analysis.validZlib ? 'valid' : 'invalid'}`);
  console.log(`- Gzip: ${analysis.validGzip ? 'valid' : 'invalid'}`);
  console.log(`- Raw: ${analysis.validRaw ? 'possibly valid' : 'likely invalid'}`);
  
  if (analysis.zlibDetails) {
    console.log('\nZlib Details:');
    console.log(`- Compression Method: ${analysis.zlibDetails.compressionMethod} (${analysis.zlibDetails.compressionMethod === 8 ? 'DEFLATE' : 'unknown'})`);
    console.log(`- Compression Info: ${analysis.zlibDetails.compressionInfo} (window size: 2^${analysis.zlibDetails.compressionInfo + 8})`);
    console.log(`- Preset Dictionary: ${analysis.zlibDetails.fdict ? 'yes' : 'no'}`);
    console.log(`- Compression Level: ${analysis.zlibDetails.flevel}`);
  }
  
  // Test decompression with all formats
  console.log('\n--- Decompression Tests ---');
  const testResults = testDecompression(data);
  
  console.log('Zlib inflate:');
  console.log(`- Success: ${testResults.zlib.success}`);
  console.log(`- ${testResults.zlib.success ? `Decompressed Size: ${testResults.zlib.bytesDecompressed} bytes` : `Error: ${testResults.zlib.error}`}`);
  console.log(`- Time: ${testResults.zlib.time}ms`);
  
  console.log('\nGzip:');
  console.log(`- Success: ${testResults.gzip.success}`);
  console.log(`- ${testResults.gzip.success ? `Decompressed Size: ${testResults.gzip.bytesDecompressed} bytes` : `Error: ${testResults.gzip.error}`}`);
  console.log(`- Time: ${testResults.gzip.time}ms`);
  
  console.log('\nRaw Deflate:');
  console.log(`- Success: ${testResults.raw.success}`);
  console.log(`- ${testResults.raw.success ? `Decompressed Size: ${testResults.raw.bytesDecompressed} bytes` : `Error: ${testResults.raw.error}`}`);
  console.log(`- Time: ${testResults.raw.time}ms`);
  
  console.log('\n--- Recommendation ---');
  if (testResults.bestFormat) {
    console.log(`Use format: ${testResults.bestFormat} (decompresses to ${testResults.bestSize} bytes)`);
  } else {
    console.log('Could not decompress with any format. Data may be corrupted or not compressed.');
    
    // Additional checks for common issues
    if (data.length < 2) {
      console.log('Data is too short to be valid compressed data');
    }
    
    // Check if it's just a plain text file
    try {
      const asText = data.toString('utf8').slice(0, 100);
      const isProbablyText = /^[\x20-\x7E\r\n\t]+$/.test(asText);
      if (isProbablyText) {
        console.log('Data appears to be plain text, not compressed:');
        console.log(asText + (data.length > 100 ? '...' : ''));
      }
    } catch (e) {
      // Ignore text conversion errors
    }
  }
  
  console.log('\n=== End of Diagnostic Report ===');
}

module.exports = {
  analyzeCompressionFormat,
  testDecompression,
  diagnoseDecompressionIssue
};

// Direct execution support
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: node compression-diagnostic.js <file-to-analyze>');
    process.exit(1);
  }
  
  const filePath = args[0];
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error(`Error reading file: ${err.message}`);
      process.exit(1);
    }
    
    diagnoseDecompressionIssue(data, 'unknown', 'Manual diagnostic');
  });
}
