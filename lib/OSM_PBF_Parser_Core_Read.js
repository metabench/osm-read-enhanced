/*
OSM PBF Format Overview:
-------------------------
1. File Structure:
   - The OSM PBF file is composed of a sequence of objects. Each object consists of a BlobHeader followed by a Blob.
   - The very first 4 bytes of the file represent a big-endian 32-bit integer that indicates the size of the BlobHeader that follows.
   - The BlobHeader is encoded using Protocol Buffers and must contain:
       • Field 1 (tag 1, wire type 2): A length-delimited string indicating the type of the block,
         such as "OSMHeader" (global metadata) or "OSMData" (data block containing nodes, ways, and relations).
       • Field 2 (tag 2, wire type 0): A varint indicating the datasize, i.e. the number of bytes comprising the subsequent Blob.
       
2. Blob and Compression:
   - Immediately after the BlobHeader, a Blob follows. Its size is specified by the "datasize" value in the BlobHeader.
   - The Blob can contain compressed data. For example, if the object type is "OSMData", the Blob may represent a PrimitiveBlock
     that is compressed (commonly with zlib compression). In some cases, additional fields (like raw_size) may indicate the uncompressed size.
   - The compression method is typically implied by the block type and any additional header fields.
   
3. Determining Boundaries:
   - To locate a block, the parser must:
       a. Read the first 4 bytes to determine header_length.
       b. Read the next header_length bytes to retrieve the BlobHeader.
       c. Extract the "datasize" from the BlobHeader to know how many bytes to read for the Blob.
   - The next object starts immediately after the Blob ends.
     
4. Parsing Considerations:
   - This parser is designed to be format-aware. It uses a state machine:
       • INIT: Reads and interprets the initial BlobHeader.
       • BLOB_DATA: Reads the Blob data according to the length given.
       • NEXT_OBJECT: Prepares for the next object.
   - In our implementation, we assume that an entire object (header and Blob) is fully contained within a single chunk.
     If any object spans multiple chunks, an error is raised.
     
5. Implications for Decompression:
   - While the parser does not decompress data, the BlobHeader information (such as type and possibly raw_size if present)
     indicates whether the Blob is compressed and which method may have been used (typically zlib).
   - This informs a future decompression step where the correct algorithm would be applied based on these header fields.
   
In summary, the parser reads the initial 4-byte header length, processes the subsequent BlobHeader (to determine the type and data size),
and then reads that many bytes as the Blob containing the actual PBF data. The positioning of subsequent objects is computed by the sum:
 [4 + header_length + datasize]. Any compression details are inferred from the header's type and additional fields.
 
Added Multi-Chunk Blob Logic:
-----------------------------
In the BLOB_DATA state, if the current input chunk does not provide the full blob data (i.e. available bytes are less than the bytes remaining to be read for this blob),
then a "blob-chunk" event is raised with the available segment (along with the input_chunk_index). The remaining blob size is updated, and the state remains 'BLOB_DATA'
so that the next input chunk will continue its data. Once the remaining bytes are available within a chunk, a final "blob-chunk" event is raised and then the 
blockIsAvailable event is raised, completing the blob.

The current input chunk index is captured at the start of processChunk() so that multiple blob-chunk events produced from the same disk chunk use the same index.

Summary:
• This core reader parses the PBF file, splitting each object by reading its 4‑byte header size,
  then the BlobHeader and Blob data.
• It assumes that the blob data is provided as is. It does not perform decompression.
• It simply reports the blob boundaries and raw blob data length; any compression details
  (e.g. zlib or others) are indicated by the BlobHeader’s type and datasize field.
• In other words, it expect blob data that may be compressed but does not itself handle decompression.
*/

const fs = require('fs');
const { Evented_Class } = require('lang-mini');
const zlib = require('zlib');
// Optionally, require an lzma decompressor if needed.

/**
 * Converts a Buffer to a hex string with spaces between bytes.
 * For example, [0x00, 0x0e, 0x0a] becomes "00 0e 0a".
 * @param {Buffer} buffer - The buffer to convert.
 * @returns {string} The space-separated hex string.
 */
function bufferToSpacedHex(buffer) {
  const hex = buffer.toString('hex');
  const matches = hex.match(/../g);
  const result = matches ? matches.join(' ') : "<no bytes>";
  // Emit a debug event to show the buffer length and result.
  // Note: This event is raised only if verbose is true and if a global "logger" is available.
  // Otherwise, you can simply console.error the data.
  // You might wrap this call with a check; for now, we'll assume it's safe.
  return result;
}

/**
 * Parses a varint (LEB128) from the buffer starting at offset.
 * Returns an object { value, bytesRead }.
 * Throws if the buffer ends prematurely.
 */
function parse_varint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  while (true) {
    if (offset >= buffer.length) {
      throw new Error("Buffer ended while reading varint");
    }
    const byte = buffer[offset++];
    bytesRead++;
    value |= (byte & 0x7F) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value, bytesRead };
}

/**
 * Parses a BlobHeader from the given buffer.
 * Expected fields:
 *   - Field 1 (tag 1, wire type 2): a length-delimited string for the header type.
 *   - Field 2 (tag 2, wire type 0): a varint for the blob's datasize.
 *   - Field 3 (tag 3, wire type 0): a varint for the blob's datasize (sometimes used in OSMHeader).
 *
 * Returns an object with properties 'type' and 'datasize'.
 */
function parse_blob_header(buffer) {
  const result = { type: null, datasize: null, raw_size: null }; // Added raw_size
  let offset = 0;
  while (offset < buffer.length) {
    const keyObj = parse_varint(buffer, offset);
    const key = keyObj.value;
    offset += keyObj.bytesRead;
    const field_number = key >> 3;
    const wire_type = key & 0x07;
    if (field_number === 1 && wire_type === 2) {
      const lenObj = parse_varint(buffer, offset);
      const str_len = lenObj.value;
      offset += lenObj.bytesRead;
      result.type = buffer.toString('utf8', offset, offset + str_len);
      offset += str_len;
    } else if ((field_number === 2 || field_number === 3) && wire_type === 0) { 
      // Accept field 2 (standard) and field 3 (sometimes used in OSMHeader) for datasize.
      const varintObj = parse_varint(buffer, offset);
      result.datasize = varintObj.value;
      offset += varintObj.bytesRead;
    } else if (field_number === 4 && wire_type === 0) {
      // Add raw_size parsing (field 4 in BlobHeader protobuf)
      const varintObj = parse_varint(buffer, offset);
      result.raw_size = varintObj.value;
      offset += varintObj.bytesRead;
    } else {
      // Skip unknown fields.
      if (wire_type === 0) {
        const skipObj = parse_varint(buffer, offset);
        offset += skipObj.bytesRead;
      } else if (wire_type === 1) {
        offset += 8;
      } else if (wire_type === 2) {
        const lenObj = parse_varint(buffer, offset);
        const len = lenObj.value;
        offset += lenObj.bytesRead + len;
      } else if (wire_type === 5) {
        offset += 4;
      } else {
        throw new Error("Unsupported wire type " + wire_type);
      }
    }
  }
  return result;
}

class OSM_PBF_Parser extends Evented_Class {
  /**
   * Constructs a new parser.
   * @param {string} file_path - The path to the OSM PBF file.
   * @param {Object} [options] - Options.
   * @param {boolean} [options.verbose=false] - If true, emit verbose events.
   */
  constructor(file_path, options = {}) {
    super();
    this.file_path = file_path;
    this.bytes_read = 0;
    this.file_size = 0;
    this.start_time = 0;
    this.last_interval_bytes = 0;
    this.chunk_index = 0;
    this.intervalId = null;
    this.verbose = options.verbose || false;
    // Optional limit on the number of chunks to process. Default is no limit.
    this.numChunksLimit = options.numChunksLimit || null; 
    // Optional limit on bytes to read from disk. Default is 24GB.
    this.read_threshold = options.read_threshold !== undefined ? options.read_threshold : (24 * 1024 * 1024 * 1024);
    // State variables for per-chunk processing.
    // Possible states: 'INIT', 'BLOB_DATA', 'NEXT_OBJECT'.
    // We expect a complete object (header+blob) to reside in one chunk.
    this.state = 'INIT';
    this.expectedObjectBytes = null;
    // Initialize headerTypes counts.
    this.headerTypes = { OSMHeader: 0, OSMData: 0 };
    this.blobIndex = 0; // New blob index counter.
    this.currentBlobChunkIndex = 0; // NEW: Counter for chunks within the current blob.
    this.highWaterMark = options.highWaterMark || (64 * 1024 * 4);
    this._currentBlobAccumulator = []; // NEW: Accumulator for blob data pieces.
    // NEW: optional blob limit
    this.maxBlobLimit = options.maxBlobLimit || null;
    this._read_stream = null; // NEW: Save the read stream for stop() use.
    this._stopped_manually = false; // NEW: Track if stopped manually
    this._threshold_reached = false; // NEW: Track if threshold was reached
  }
  
  /**
   * Formats an array of values into a fixed-width table row.
   * @param {Array} values - The values to format.
   * @param {Array} widths - The fixed widths for each column.
   * @returns {string} The formatted table row.
   */
  formatRow(values, widths) {
    return values
      .map((val, i) => String(val).padStart(widths[i]))
      .join(' | ');
  }
  
  // --- New modular state management functions ---
  
  _handleInit(chunk, offset, chunkStart, bufLength, currentInputChunkIndex) {
    if (offset + 4 > bufLength) {
      if (this.verbose) {
        this.raise('verbose', { info: "Incomplete header size bytes", localOffset: offset, globalOffset: chunkStart + offset, bufLength });
      }
      return offset;
    }
    const headerSize = chunk.readUInt32BE(offset);
    if (headerSize > 4096) {
      if (this.verbose) {
        this.raise('verbose', { info: "Unexpectedly high headerSize", headerSize, localOffset: offset, globalOffset: chunkStart + offset, rawBytes: bufferToSpacedHex(chunk.slice(offset, offset + 4)) });
      }
      throw new Error(`Sanity check failed: headerSize (${headerSize}) exceeds 4096 bytes at global offset ${chunkStart + offset}`);
    }
    if (this.verbose) {
      this.raise('verbose', { info: "Header length read", headerSize, localOffset: offset, globalOffset: chunkStart + offset, raw: bufferToSpacedHex(chunk.slice(offset, offset + 4)), encoding: "Big-endian 32-bit unsigned integer" });
    }
    const totalHeaderLen = 4 + headerSize;
    if (offset + totalHeaderLen > bufLength) {
      if (this.verbose) {
        this.raise('verbose', { info: "Incomplete header bytes; waiting for more data", localOffset: offset, globalOffset: chunkStart + offset, expectedTotalHeaderLen: totalHeaderLen, bufLength });
      }
      return offset;
    }
    const blobHeaderBuffer = chunk.slice(offset + 4, offset + totalHeaderLen);
    if (this.verbose) {
      this.raise('verbose', { info: "Attempting to parse BlobHeader", chunkIndex: this.chunk_index, localOffset: offset, globalOffset: chunkStart + offset, totalHeaderLen, headerContent: bufferToSpacedHex(chunk.slice(offset, offset + totalHeaderLen)), encoding: "Protocol Buffers (UTF-8 for strings)" });
    }
    let blobHeader;
    try {
      blobHeader = parse_blob_header(blobHeaderBuffer);
    } catch (e) {
      throw new Error(`Error parsing BlobHeader at global offset ${chunkStart + offset}: ${e.message}. Raw header: ${bufferToSpacedHex(blobHeaderBuffer)}`);
    }
    if (!blobHeader || !blobHeader.type || blobHeader.datasize == null) {
      throw new Error(`Invalid blob header at global offset ${chunkStart + offset}. Received: ${JSON.stringify(blobHeader)}. Raw header: ${bufferToSpacedHex(blobHeaderBuffer)}`);
    }
    if (blobHeader.type !== "OSMHeader" && blobHeader.type !== "OSMData") {
      throw new Error(`Unexpected blob header type: ${blobHeader.type} at global offset ${chunkStart + offset}. Raw header: ${bufferToSpacedHex(blobHeaderBuffer)}`);
    }
    try {
      if (this.headerTypes[blobHeader.type] !== undefined) {
        this.headerTypes[blobHeader.type]++;
      } else {
        throw new Error(`headerTypes does not have key "${blobHeader.type}"`);
      }
    } catch (e) {
      throw new Error(`Error updating headerTypes at global offset ${chunkStart + offset}: ${e.message}. Parsed header: ${JSON.stringify(blobHeader)}`);
    }
    if (this.verbose) {
      this.raise('verbose', { info: "Successfully parsed BlobHeader", chunkIndex: this.chunk_index, blobIndex: this.blobIndex, headerDetails: blobHeader, headerSize, globalHeaderStart: chunkStart + offset });
    }
    this.blobIndex++;
    this._currentBlobHeader = blobHeader;
    this._currentHeaderSize = headerSize;
    this.raise('headerBoundariesIdentified', { info: "Identified BlobHeader boundaries", headerDetails: blobHeader, headerStartGlobal: chunkStart + offset, headerEndGlobal: chunkStart + offset + totalHeaderLen, headerLength: totalHeaderLen, chunkIndex: this.chunk_index, blobIndex: this.blobIndex - 1 });
    this._currentBlobDatasize = blobHeader.datasize;
    this._currentHeaderEnd = chunkStart + offset + totalHeaderLen;
    // initialize accumulator for this blob
    this._currentBlobAccumulator = [];
    this.state = 'BLOB_DATA';
    this.currentBlobChunkIndex = 0;
    return offset + totalHeaderLen;
  }
  
  _handleBlobData(chunk, offset, chunkStart, bufLength, currentInputChunkIndex) {
    const remainingNeeded = this._currentBlobDatasize;
    const available = bufLength - offset;
    const currentChunkData = chunk.slice(offset, offset + Math.min(available, remainingNeeded));
    this._currentBlobAccumulator.push(currentChunkData);
    if (available < remainingNeeded) {
      this._currentBlobDatasize = remainingNeeded - available;
      return bufLength; // all bytes consumed from this chunk
    } else {
      const finalBlob = Buffer.concat(this._currentBlobAccumulator);
      // NEW: Check if maxBlobLimit is reached.
      if (this.maxBlobLimit !== null && (this.blobIndex - 1) >= this.maxBlobLimit) {
        this.raise('limit', { message: `Blob limit of ${this.maxBlobLimit} reached.`, blobIndex: this.blobIndex });
        this.stop();
        return offset + remainingNeeded;
      }
      this.raise('blob', {
        blobIndex: this.blobIndex,
        blobData: finalBlob,
        input_chunk_index: currentInputChunkIndex,
        globalDataStart: chunkStart + offset,
        blobDataLength: finalBlob.length,
        headerDetails: { type: this._currentBlobHeader.type, datasize: this._currentBlobHeader.datasize }
      });
      // Reset accumulator and state for the next object.
      this._currentBlobAccumulator = [];
      this._currentBlobDatasize = 0;
      this._currentHeaderEnd = null;
      this._currentBlobHeader = null;
      this._currentHeaderSize = null;
      this.state = 'NEXT_OBJECT';
      return offset + remainingNeeded;
    }
  }
  
  _handleNextObject(chunk, offset, chunkStart, bufLength) {
    if (this.verbose) {
      this.raise('verbose', {
        info: "Completed object",
        localOffset: offset,
        globalOffset: chunkStart + offset,
        totalChunkLength: bufLength,
        leftoverSnippet: bufferToSpacedHex(chunk.slice(offset, offset + 16))
      });
    }
    this.state = 'INIT';
    this.expectedObjectBytes = null;
    return offset;
  }
  
  /**
   * Processes a single incoming chunk.
   * Each object must be fully contained in the chunk. Errors are thrown if not.
   * @param {Buffer} chunk - The current chunk.
   */
  processChunk(chunk) {
    // Compute the absolute offset of this chunk in the file:
    const chunkStart = this.bytes_read - chunk.length;
    let offset = 0;
    const bufLength = chunk.length;
    const currentInputChunkIndex = this.chunk_index; // Capture current input chunk index
    if (this.verbose) {
      this.raise('verbose', { info: "Starting processChunk", localBufLength: bufLength, globalChunkStart: chunkStart, localOffset: offset, globalOffset: chunkStart + offset });
    }
    
    while (offset < bufLength) {
      if (this.state === 'INIT') {
        const newOffset = this._handleInit(chunk, offset, chunkStart, bufLength, currentInputChunkIndex);
        if (newOffset === offset) break; // waiting for more data
        offset = newOffset;
      } else if (this.state === 'BLOB_DATA') {
        offset = this._handleBlobData(chunk, offset, chunkStart, bufLength, currentInputChunkIndex);
      } else if (this.state === 'NEXT_OBJECT') {
        offset = this._handleNextObject(chunk, offset, chunkStart, bufLength);
      }
    }
    
    if (offset < bufLength) {
      const leftoverLength = bufLength - offset;
      const globalLeftoverOffset = chunkStart + offset;
      this.leftoverBuffer = chunk.slice(offset);
      if (this.verbose) {
        this.raise('verbose', { 
          info: "Storing leftover data",
          leftoverLength,
          localOffset: offset,
          globalLeftoverOffset
        });
      }
    }
  }
  
  /**
   * Starts streaming the file and tracking progress.
   */
  async parse() {
    try {
      const stats = await fs.promises.stat(this.file_path);
      this.file_size = stats.size;
    } catch (err) {
      this.raise('error', err);
      return;
    }
    
    this.start_time = Date.now();
    this.last_interval_bytes = 0;
    this.raise('start', { file_path: this.file_path, file_size: this.file_size });
    const headers = ['Chunk', 'Time(s)', 'LastSec(MB/s)', 'Overall(MB/s)', 'Percent', 'EstTot(s)', 'EstRem(s)', 'Total(MB)'];
    const colWidths = [8, 8, 16, 16, 10, 12, 12, 12];
    console.log(this.formatRow(headers, colWidths));
    console.log('-'.repeat(colWidths.reduce((a, b) => a + b + 3, -3)));
    
    this.intervalId = setInterval(() => {
      const now = Date.now(),
            elapsed = (now - this.start_time) / 1000;
      const last_sec_mb = this.bytes_read 
              ? ((this.bytes_read - this.last_interval_bytes) / (1024 * 1024)).toFixed(2)
              : "0.00";
      const overall_mb_s = this.bytes_read 
              ? ((this.bytes_read / (1024 * 1024)) / (elapsed || 1)).toFixed(2)
              : "0.00";
      const percent_complete = this.file_size 
              ? ((this.bytes_read / this.file_size) * 100).toFixed(2) + '%'
              : "0.00%";
      const estimated_total_time = this.bytes_read 
              ? ((this.file_size / this.bytes_read) * elapsed).toFixed(1)
              : "0";
      const estimated_remaining = this.bytes_read 
              ? ((estimated_total_time - elapsed)).toFixed(1)
              : "0";
      const total_mb = (this.bytes_read / (1024 * 1024)).toFixed(2);
      this.last_interval_bytes = this.bytes_read;
      const row = [this.chunk_index, elapsed.toFixed(1), last_sec_mb, overall_mb_s, percent_complete, estimated_total_time, estimated_remaining, total_mb];
      console.log(this.formatRow(row, [8,8,16,16,10,12,12,12]));
    }, 1000);
    
    const read_stream = fs.createReadStream(this.file_path, { highWaterMark: this.highWaterMark });
    this._read_stream = read_stream; // NEW: Save the read stream for stop() use.
    const destroyOnError = (error) => {
      this.raise('error', error);
      if (this.intervalId) clearInterval(this.intervalId);
      read_stream.destroy();
    };
    
    read_stream.on('data', (chunk) => {
      if (this.numChunksLimit !== null && this.chunk_index >= this.numChunksLimit) {
        console.log(`Chunk limit of ${this.numChunksLimit} reached. Stopping further processing.`);
        this.raise('limit', { message: "Chunk limit reached.", chunk_index: this.chunk_index });
        clearInterval(this.intervalId);
        read_stream.destroy();
        return;
      }
      
      // Check read threshold BEFORE processing the chunk
      if (this.read_threshold !== null && (this.bytes_read + chunk.length) > this.read_threshold) {
        // Process only the portion that stays within the threshold
        const remaining_bytes = this.read_threshold - this.bytes_read;
        if (remaining_bytes > 0) {
          const partial_chunk = chunk.slice(0, remaining_bytes);
          this.bytes_read += partial_chunk.length;
          try {
            this.processChunk(partial_chunk);
          } catch (e) {
            destroyOnError(e);
            return;
          }
          this.raise('chunk', { offset: this.bytes_read - partial_chunk.length, chunk_length: partial_chunk.length, chunk_index: this.chunk_index });
          this.chunk_index++;
        }
        
        this._threshold_reached = true;
        const mb_read = (this.bytes_read / (1024 * 1024)).toFixed(2);
        const threshold_mb = (this.read_threshold / (1024 * 1024)).toFixed(2);
        console.log(`Read threshold of ${threshold_mb}MB reached (read: ${mb_read}MB). Stopping further processing.`);
        this.raise('limit', { 
          message: "Read threshold reached.", 
          bytes_read: this.bytes_read, 
          read_threshold: this.read_threshold 
        });
        clearInterval(this.intervalId);
        read_stream.destroy();
        return;
      }
      
      this.bytes_read += chunk.length;
      
      try {
        this.processChunk(chunk);
      } catch (e) {
        destroyOnError(e);
        return;
      }
      this.raise('chunk', { offset: this.bytes_read - chunk.length, chunk_length: chunk.length, chunk_index: this.chunk_index });
      this.chunk_index++;
    });
    
    read_stream.on('end', () => {
      if (this.intervalId) clearInterval(this.intervalId);
      const elapsed = (Date.now() - this.start_time) / 1000;
      const total_mb = (this.bytes_read / (1024 * 1024)).toFixed(2);
      const overall_mb_s = (total_mb / elapsed).toFixed(2);
      
      if (this._threshold_reached) {
        console.log(`\n✅ Completed parsing at threshold limit. Total time: ${elapsed.toFixed(1)}s, Total data: ${total_mb}MB, Overall speed: ${overall_mb_s}MB/s`);
      } else if (this._stopped_manually) {
        console.log(`\n⚠️  Parsing stopped manually (CTRL+C). Total time: ${elapsed.toFixed(1)}s, Total data: ${total_mb}MB, Overall speed: ${overall_mb_s}MB/s`);
      } else if (this.bytes_read < this.file_size && !this._threshold_reached) {
        console.log(`\n⚠️  Parsing stopped manually (interrupted). Total time: ${elapsed.toFixed(1)}s, Total data: ${total_mb}MB, Overall speed: ${overall_mb_s}MB/s`);
        this._stopped_manually = true;
      } else {
        console.log(`\n✅ Completed parsing entire file. Total time: ${elapsed.toFixed(1)}s, Total data: ${total_mb}MB, Overall speed: ${overall_mb_s}MB/s`);
      }
      
      this.raise('end', { 
        elapsed, 
        total_mb, 
        overall_mb_s, 
        threshold_reached: this._threshold_reached,
        stopped_manually: this._stopped_manually
      });
    });
    
    read_stream.on('error', destroyOnError);
  }
  
  // NEW: stop() method to cease processing.
  stop() {
    if (this._read_stream) {
      this._read_stream.destroy();
      this._read_stream = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.raise('stopped', { message: "Parser stopped due to blob limit reached." });
  }
}

module.exports = OSM_PBF_Parser;  

// Replace the driver code below:
if (require.main === module) {
  const pbf_path = "D:\\planet-250203.osm.pbf";
  // Accept highWaterMark as an optional argument (default: 1MB)
  const highWaterMark = process.argv[3] ? parseInt(process.argv[3], 10) : (4 * 1024 * 1024);
  // Set read threshold to 24GB by default (can be overridden)
  const read_threshold = 24 * 1024 * 1024 * 1024; // 24GB in bytes
  const parser = new OSM_PBF_Parser(pbf_path, { verbose: true, highWaterMark, read_threshold });
  
  // Add signal handlers for manual interruption (works better on Windows)
  let interruptHandled = false;
  const handleInterrupt = (signal) => {
    if (interruptHandled) return;
    interruptHandled = true;
    console.log(`\n🛑 Received ${signal} signal - stopping parser manually...`);
    parser._stopped_manually = true;
    parser.stop();
    setTimeout(() => process.exit(0), 100);
  };
  
  // Multiple signal handlers for better Windows compatibility
  process.on('SIGINT', () => handleInterrupt('SIGINT'));
  process.on('SIGTERM', () => handleInterrupt('SIGTERM'));
  process.on('SIGBREAK', () => handleInterrupt('SIGBREAK')); // Windows specific
  
  // Also handle beforeExit to catch manual stops
  process.on('beforeExit', (code) => {
    if (code !== 0 && !parser._threshold_reached) {
      console.log('🛑 Process exiting due to manual interruption');
      parser._stopped_manually = true;
    }
  });
  
  //parser.on('verbose', (event) => {
    //console.log('verbose event', event);
  //});

  let l = 0;
  parser.on('blob', (event) => {
    //console.log('blob event', event);
    const { blobData, blobIndex, input_chunk_index, globalDataStart, blobDataLength, headerDetails } = event;
    l += blobDataLength;
  });
  parser.on('end', (event) => {
    console.log('end event', event);
    console.log('Total blob bytes:', l);
  });
  parser.on('limit', (event) => {
    console.log('🔴 Limit reached:', event.message);
    console.log('Total blob bytes:', l);
  });
  parser.on('stopped', (event) => {
    console.log('🛑 Parser stopped:', event.message);
    console.log('Total blob bytes:', l);
  });
  parser.parse();
}
