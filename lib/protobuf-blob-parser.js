/**
 * Helper module to parse Blob structures in OSM PBF files
 * Used by the decompression parser to correctly identify compression types
 */

// Simple varint parser for protobuf
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
 * Parse a Blob from a buffer to determine its compression type and data
 * 
 * Blob structure (from .proto):
 * message Blob {
 *   optional bytes raw = 1;
 *   optional int32 raw_size = 2;
 *   optional bytes zlib_data = 3;
 *   optional bytes lzma_data = 4;
 *   optional bytes OBSOLETE_bzip2_data = 5;
 *   optional bytes lz4_data = 6;
 *   optional bytes zstd_data = 7;
 * }
 */
function parseBlob(buffer) {
  let offset = 0;
  const result = {
    raw: null,
    raw_size: null,
    zlib_data: null,
    lzma_data: null,
    lz4_data: null,
    zstd_data: null,
    compression_type: null
  };
  
  try {
    while (offset < buffer.length) {
      // Read field key
      const keyInfo = parseVarint(buffer, offset);
      offset += keyInfo.bytesRead;
      
      const fieldNumber = keyInfo.value >> 3;
      const wireType = keyInfo.value & 0x07;
      
      // Read field value based on wire type
      if (wireType === 0) { // Varint
        const valueInfo = parseVarint(buffer, offset);
        offset += valueInfo.bytesRead;
        
        if (fieldNumber === 2) { // raw_size
          result.raw_size = valueInfo.value;
        }
      } else if (wireType === 2) { // Length-delimited (for bytes fields)
        const lenInfo = parseVarint(buffer, offset);
        offset += lenInfo.bytesRead;
        
        const dataStart = offset;
        const dataLength = lenInfo.value;
        offset += dataLength;
        
        if (offset > buffer.length) {
          throw new Error("Buffer too short for length-delimited field");
        }
        
        const fieldData = buffer.slice(dataStart, dataStart + dataLength);
        
        if (fieldNumber === 1) { // raw
          result.raw = fieldData;
          result.compression_type = 'none';
        } else if (fieldNumber === 3) { // zlib_data
          result.zlib_data = fieldData;
          result.compression_type = 'zlib';
        } else if (fieldNumber === 4) { // lzma_data
          result.lzma_data = fieldData;
          result.compression_type = 'lzma';
        } else if (fieldNumber === 6) { // lz4_data
          result.lz4_data = fieldData;
          result.compression_type = 'lz4';
        } else if (fieldNumber === 7) { // zstd_data
          result.zstd_data = fieldData;
          result.compression_type = 'zstd';
        }
      } else {
        // Skip other wire types
        if (wireType === 1) offset += 8; // 64-bit
        else if (wireType === 5) offset += 4; // 32-bit
        else throw new Error(`Unsupported wire type: ${wireType}`);
      }
    }
  } catch (error) {
    console.error("Error parsing blob:", error);
    // Continue and return what we have so far
  }
  
  // Return the actual data along with metadata
  return {
    raw_size: result.raw_size,
    compression_type: result.compression_type,
    data: result.raw || result.zlib_data || result.lzma_data || 
          result.lz4_data || result.zstd_data || null
  };
}

module.exports = { parseBlob, parseVarint };
