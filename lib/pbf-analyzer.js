/**
 * Utility module to analyze and extract information from PBF files
 * Helps with debugging and improving parsing logic
 */

const fs = require('fs');
const zlib = require('zlib');

/**
 * Parse varint from buffer
 */
function parseVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (true) {
    if (offset + bytesRead >= buffer.length) {
      throw new Error("Buffer ended while reading varint");
    }
    
    const byte = buffer[offset + bytesRead++];
    result |= (byte & 0x7F) << shift;
    
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  
  return { value: result, bytesRead };
}

/**
 * Convert buffer to hex representation for debugging
 */
function bufferToHexString(buffer, maxBytes = 32) {
  if (!buffer || buffer.length === 0) return "<empty buffer>";
  
  const bytes = Array.from(buffer.slice(0, maxBytes)).map(b => b.toString(16).padStart(2, '0'));
  let result = bytes.join(' ');
  
  if (buffer.length > maxBytes) {
    result += ` ... (${buffer.length - maxBytes} more bytes)`;
  }
  
  return result;
}

/**
 * Analyze a PBF file and print information about its structure
 */
function analyzePBFFile(filePath, options = {}) {
  const verbose = options.verbose || false;
  const maxBlobs = options.maxBlobs || 10;
  
  console.log(`Analyzing PBF file: ${filePath}`);
  
  fs.open(filePath, 'r', (err, fd) => {
    if (err) {
      console.error(`Error opening file: ${err.message}`);
      return;
    }
    
    let position = 0;
    let blobCount = 0;
    
    function readNextHeader() {
      // Read header size (4 bytes)
      const headerSizeBuffer = Buffer.alloc(4);
      fs.read(fd, headerSizeBuffer, 0, 4, position, (err, bytesRead) => {
        if (err || bytesRead < 4) {
          console.log(`Finished analysis. Found ${blobCount} blobs.`);
          fs.close(fd, () => {});
          return;
        }
        
        const headerSize = headerSizeBuffer.readUInt32BE(0);
        position += 4;
        
        // Read header content
        const headerBuffer = Buffer.alloc(headerSize);
        fs.read(fd, headerBuffer, 0, headerSize, position, (err, bytesRead) => {
          if (err || bytesRead < headerSize) {
            console.error(`Error reading header: ${err ? err.message : 'Unexpected end of file'}`);
            fs.close(fd, () => {});
            return;
          }
          
          position += headerSize;
          
          // Parse header
          try {
            const headerInfo = parseHeaderInfo(headerBuffer);
            console.log(`\nBlob #${blobCount + 1}:`);
            console.log(`  Type: ${headerInfo.type}`);
            console.log(`  Data size: ${headerInfo.datasize} bytes`);
            if (headerInfo.raw_size) {
              console.log(`  Raw size: ${headerInfo.raw_size} bytes`);
            }
            
            // Read blob data
            const blobBuffer = Buffer.alloc(headerInfo.datasize);
            fs.read(fd, blobBuffer, 0, headerInfo.datasize, position, (err, bytesRead) => {
              if (err || bytesRead < headerInfo.datasize) {
                console.error(`Error reading blob: ${err ? err.message : 'Unexpected end of file'}`);
                fs.close(fd, () => {});
                return;
              }
              
              position += headerInfo.datasize;
              
              // Analyze blob
              analyzeBlob(blobBuffer, headerInfo, verbose);
              
              blobCount++;
              if (blobCount < maxBlobs) {
                // Continue to next blob
                readNextHeader();
              } else {
                console.log(`\nReached maximum blob count (${maxBlobs}). Analysis stopped.`);
                fs.close(fd, () => {});
              }
            });
          } catch (e) {
            console.error(`Error parsing header: ${e.message}`);
            console.log(`Header hex: ${bufferToHexString(headerBuffer)}`);
            fs.close(fd, () => {});
          }
        });
      });
    }
    
    readNextHeader();
  });
}

/**
 * Parse header information from buffer
 */
function parseHeaderInfo(buffer) {
  const result = { type: null, datasize: null, raw_size: null };
  let offset = 0;
  
  while (offset < buffer.length) {
    const keyInfo = parseVarint(buffer, offset);
    offset += keyInfo.bytesRead;
    
    const field = keyInfo.value >> 3;
    const wireType = keyInfo.value & 0x07;
    
    if (field === 1 && wireType === 2) {
      // Type field (string)
      const lenInfo = parseVarint(buffer, offset);
      offset += lenInfo.bytesRead;
      
      result.type = buffer.toString('utf8', offset, offset + lenInfo.value);
      offset += lenInfo.value;
    } else if ((field === 2 || field === 3) && wireType === 0) {
      // Datasize field (int32)
      const sizeInfo = parseVarint(buffer, offset);
      offset += sizeInfo.bytesRead;
      
      result.datasize = sizeInfo.value;
    } else if (field === 4 && wireType === 0) {
      // Raw_size field (int32)
      const sizeInfo = parseVarint(buffer, offset);
      offset += sizeInfo.bytesRead;
      
      result.raw_size = sizeInfo.value;
    } else {
      // Skip unknown field
      if (wireType === 0) {
        // Varint
        const varInfo = parseVarint(buffer, offset);
        offset += varInfo.bytesRead;
      } else if (wireType === 1) {
        // 64-bit
        offset += 8;
      } else if (wireType === 2) {
        // Length-delimited
        const lenInfo = parseVarint(buffer, offset);
        offset += lenInfo.bytesRead + lenInfo.value;
      } else if (wireType === 5) {
        // 32-bit
        offset += 4;
      } else {
        throw new Error(`Unknown wire type: ${wireType}`);
      }
    }
  }
  
  return result;
}

/**
 * Analyze blob data
 */
function analyzeBlob(buffer, headerInfo, verbose) {
  console.log(`  Blob data size: ${buffer.length} bytes`);
  
  // Check for compression signatures
  let compressionType = "unknown";
  if (buffer.length >= 2) {
    if (buffer[0] === 0x78 && (buffer[1] === 0x01 || buffer[1] === 0x9C || buffer[1] === 0xDA)) {
      compressionType = "zlib";
    } else if (buffer[0] === 0x1F && buffer[1] === 0x8B) {
      compressionType = "gzip";
    }
  }
  
  console.log(`  Compression: ${compressionType}`);
  
  if (verbose) {
    console.log(`  Data preview: ${bufferToHexString(buffer)}`);
  }
  
  // Try to decompress if it looks compressed
  if (compressionType !== "unknown") {
    try {
      let decompressor;
      
      if (compressionType === "zlib") {
        decompressor = zlib.inflate;
      } else if (compressionType === "gzip") {
        decompressor = zlib.gunzip;
      }
      
      if (decompressor) {
        decompressor(buffer, (err, result) => {
          if (err) {
            console.log(`  Decompression failed: ${err.message}`);
          } else {
            console.log(`  Decompressed size: ${result.length} bytes`);
            if (verbose) {
              console.log(`  Decompressed preview: ${bufferToHexString(result)}`);
            }
          }
        });
      }
    } catch (e) {
      console.log(`  Decompression error: ${e.message}`);
    }
  }
}

// Export functions
module.exports = {
  analyzePBFFile,
  parseVarint,
  bufferToHexString
};

// Allow direct execution
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Please provide a PBF file path as argument");
    process.exit(1);
  }
  
  analyzePBFFile(filePath, {
    verbose: process.argv.includes("--verbose") || process.argv.includes("-v"),
    maxBlobs: parseInt(process.argv.find(arg => arg.startsWith("--max="))?.split("=")[1] || "10", 10)
  });
}
