/*
 * OSM_Blob class: Direct PBF Blob Content Parser
 * ==============================================
 * 
 * This class operates at the BLOB CONTENT LEVEL of the PBF format hierarchy.
 * It receives decompressed blob data and provides efficient parsing without external protobuf libraries.
 * 
 * PERFORMANCE TIMING & OPTIMIZATION:
 * • Comprehensive timing instrumentation for all major operations
 * • Verbose timing mode for detailed performance analysis
 * • Fast, optimized parsing with minimal object creation
 *
 * 

 * PBF BLOB STRUCTURE (this class operates here):
 * 
 * BLOB CONTENT (after decompression from FileBlock → BlobHeader → Blob):
 *    OSMData Blob: Contains PrimitiveBlock with actual OSM data
 *       - Field 1: stringtable (StringTable message)
 *       - Field 2: primitivegroup[] (PrimitiveGroup messages with nodes)
 *       - Field 3: primitivegroup[] (PrimitiveGroup messages with ways)  
 *       - Field 4: primitivegroup[] (PrimitiveGroup messages with relations)
 *       - Field 17: granularity (int32, default: 100 nanodegrees)
 *       - Field 18: date_granularity (int32, default: 1000 milliseconds)
 *       - Field 19: lat_offset (int64, default: 0)
 *       - Field 20: lon_offset (int64, default: 0)
 * 
 * STRINGTABLE STRUCTURE (Field 1 of PrimitiveBlock):
 *    - Field 1: s[] - Array of UTF-8 byte strings
 *    - Index 0: Always empty string ("")
 *    - Index 1+: Actual strings referenced throughout the block
 *    - Wire format: Each string is length-delimited (wire type 2)
 * 
 * PRIMITIVEGROUP STRUCTURE (Fields 2-4 of PrimitiveBlock):
 *    - Field 1: nodes[] (individual Node messages - rarely used)
 *    - Field 2: dense (DenseNodes message - most common for nodes)
 *    - Field 3: ways[] (Way messages)
 *    - Field 4: relations[] (Relation messages)
 *    - Field 5: changesets[] (Changeset messages - rare)
 * 
 * DENSENODES STRUCTURE (Field 2 of PrimitiveGroup):
 *    - Field 1: id[] (packed sint64, delta-encoded node IDs)
 *    - Field 5: denseinfo (DenseInfo with metadata - optional)
 *    - Field 8: lat[] (packed sint64, delta-encoded latitudes)
 *    - Field 9: lon[] (packed sint64, delta-encoded longitudes)
 *    - Field 10: keys_vals[] (packed int32, interleaved key/value string indices)
 * 
 * WAY STRUCTURE (Field 3 of PrimitiveGroup):
 *    - Field 1: id (int64, way ID)
 *    - Field 2: keys[] (repeated uint32, string table indices for tag keys)
 *    - Field 3: vals[] (repeated uint32, string table indices for tag values)
 *    - Field 4: info (Info with metadata - optional)
 *    - Field 8: refs[] (packed sint64, delta-encoded node references)
 * 
 * RELATION STRUCTURE (Field 4 of PrimitiveGroup):
 *    - Field 1: id (int64, relation ID)
 *    - Field 2: keys[] (repeated uint32, string table indices for tag keys)
 *    - Field 3: vals[] (repeated uint32, string table indices for tag values)
 *    - Field 4: info (Info with metadata - optional)
 *    - Field 8: roles_sid[] (repeated int32, string table indices for member roles)
 *    - Field 9: memids[] (packed sint64, delta-encoded member IDs)
 *    - Field 10: types[] (repeated MemberType enum: NODE=0, WAY=1, RELATION=2)
 * 
 * PROTOBUF WIRE FORMAT BASICS:
 *    - Tag = (field_number << 3) | wire_type
 *    - Wire Type 0: Varint (int32, int64, uint32, uint64, sint32, sint64, bool, enum)
 *    - Wire Type 1: 64-bit (fixed64, sfixed64, double)
 *    - Wire Type 2: Length-delimited (string, bytes, embedded messages, packed arrays)
 *    - Wire Type 5: 32-bit (fixed32, sfixed32, float)
 *    - Varint encoding: 7 bits per byte, MSB=1 means more bytes follow
 *    - Signed varint (sint32/sint64): ZigZag encoding: (n << 1) ^ (n >> 31)
 * 
 * PARSING STRATEGY:
 *    1. Locate StringTable (field 1) first - needed for all string lookups
 *    2. Build string lookup array for fast access by index
 *    3. Scan for PrimitiveGroup fields (2, 3, 4) and parse based on content
 *    4. Handle delta decoding for IDs and coordinates
 *    5. Use string indices to resolve keys, values, roles, usernames
 * 
 * PERFORMANCE OPTIMIZATIONS:
 *    - Pre-build string lookup table instead of lazy iteration
 *    - Minimal object creation during parsing
 *    - Event-driven parsing to avoid building large data structures
 *    - Direct buffer access with manual protobuf decoding
 *    - Cache string table slice location for repeated access
 * 
 * CLASS INTERFACE:
 * • Accepts a spec object with:
 *     - index: the integer index of the blob.
 *     - data: the decompressed blob data (Buffer or Uint8Array).
 * • Exposes a .buffer property for the raw data.
 * • Implements its own PBF decoding (without external modules) to extract the stringtable.
 * • Provides an iterate_stringtable() method that returns an iterable over the UTF-8 strings in the stringtable.
 * • Provides a fastParse(eventEmitter) method for high-performance event-driven parsing.
 */
class OSM_Blob {
  constructor(spec = {}) {
    if (spec.index === undefined) {
      throw new Error("Missing required 'index' property");
    }
    if (spec.data === undefined) {
      throw new Error("Missing required 'data' property");
    }
    this._index = spec.index;
    // Always store data as a Buffer.
    this._buffer = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data);
    // Cache for the stringtable slice information (start and end within _buffer).
    this._stringtableSlice = null;
    
    // Performance and timing options
    this._timing_verbose = spec.timing_verbose || false;
    this._performance_stats = {
      construction_time: 0,
      string_table_time: 0,
      block_properties_time: 0,
      element_counting_time: 0,
      node_parsing_time: 0,
      way_parsing_time: 0,
      relation_parsing_time: 0,
      total_operations: 0
    };
    
    // Start construction timing
    const construction_start = this._timing_verbose ? process.hrtime.bigint() : null;
    
    // Block properties with defaults
    this._granularity = 100; // default: 100 nanodegrees
    this._lat_offset = 0;    // default: 0
    this._lon_offset = 0;    // default: 0
    this._date_granularity = 1000; // default: 1000 milliseconds
    
    // Parse block properties on construction
    const block_props_start = this._timing_verbose ? process.hrtime.bigint() : null;
    this._parseBlockProperties();
    if (this._timing_verbose && block_props_start) {
      this._performance_stats.block_properties_time = Number(process.hrtime.bigint() - block_props_start);
      this._logTiming('Block properties parsing', this._performance_stats.block_properties_time);
    }
    
    // End construction timing
    if (this._timing_verbose && construction_start) {
      this._performance_stats.construction_time = Number(process.hrtime.bigint() - construction_start);
      this._logTiming('Blob construction', this._performance_stats.construction_time);
    }
    
    // Debug: Log first few bytes to understand blob structure
    if (this._buffer.length > 0 && spec.debug) {
      console.log(`Debug Blob ${this._index}: First 20 bytes:`, 
        Array.from(this._buffer.slice(0, Math.min(20, this._buffer.length)))
          .map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
    }
  }

  // Returns the blob's index.
  get index() {
    return this._index;
  }

  // Returns the raw blob data.
  get buffer() {
    return this._buffer;
  }

  // Optimized varint reading with fast path for single-byte values (0-127)
  _readVarint(buffer, offset) {
    // Fast path: single byte varint (covers 90% of cases)
    const firstByte = buffer[offset];
    if (firstByte < 0x80) {
      return { value: firstByte, bytesRead: 1 };
    }
    
    // Fallback to multi-byte varint
    let result = firstByte & 0x7F;
    let shift = 7;
    let bytesRead = 1;
    
    while (bytesRead < 5) { // Max 5 bytes for 32-bit varint
      if (offset + bytesRead >= buffer.length) {
        throw new Error("Buffer ended while reading varint");
      }
      const byte = buffer[offset + bytesRead];
      bytesRead++;
      result |= (byte & 0x7F) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    
    return { value: result >>> 0, bytesRead }; // Ensure unsigned 32-bit
  }

  // Optimized signed varint with fast path for small values
  _readSignedVarint(buffer, offset) {
    // Fast path: single byte
    const firstByte = buffer[offset];
    if (firstByte < 0x80) {
      // ZigZag decode: (n >> 1) ^ (-(n & 1))
      const value = (firstByte >> 1) ^ (-(firstByte & 1));
      return { value, bytesRead: 1 };
    }
    
    // Fallback to multi-byte
    const varint = this._readVarint(buffer, offset);
    const value = (varint.value >> 1) ^ (-(varint.value & 1));
    return { value, bytesRead: varint.bytesRead };
  }

  // Internal helper to skip an unknown field given its wire type.
  // Returns the new offset.
  _skipField(buffer, offset, wireType) {
    switch (wireType) {
      case 0: { // Varint
        const varint = this._readVarint(buffer, offset);
        return offset + varint.bytesRead;
      }
      case 1: { // 64-bit (fixed64, sfixed64, double)
        return offset + 8;
      }
      case 2: { // Length-delimited (string, bytes, embedded messages, packed repeated)
        const lenVar = this._readVarint(buffer, offset);
        return offset + lenVar.bytesRead + lenVar.value;
      }
      case 3: { // Start group (deprecated in proto3, but may still appear)
        // Skip until we find the corresponding end group (wire type 4)
        let groupLevel = 1;
        let currentOffset = offset;
        while (groupLevel > 0 && currentOffset < buffer.length) {
          const keyInfo = this._readVarint(buffer, currentOffset);
          currentOffset += keyInfo.bytesRead;
          const currentWireType = keyInfo.value & 0x07;
          
          if (currentWireType === 3) {
            groupLevel++;
          } else if (currentWireType === 4) {
            groupLevel--;
          } else {
            currentOffset = this._skipField(buffer, currentOffset, currentWireType);
          }
        }
        return currentOffset;
      }
      case 4: { // End group (deprecated in proto3)
        return offset; // Just return current offset, should be handled by case 3
      }
      case 5: { // 32-bit (fixed32, sfixed32, float)
        return offset + 4;
      }
      default:
        // Log debug info for unknown wire types but try to recover
        const hexBytes = Array.from(buffer.slice(Math.max(0, offset-5), Math.min(buffer.length, offset+10)))
          .map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
        console.warn(`Unknown wire type ${wireType} at offset ${offset}. Context: ${hexBytes}`);
        
        // For wire types > 5, this might indicate corrupted data or a parsing error
        // Try to recover by advancing one byte and continuing
        return offset + 1;
    }
  }

  // Internal method to locate the stringtable slice inside the decompressed blob.
  // The PrimitiveBlock message has field number 1 (wire type 2) that contains the stringtable message.
  _findStringTableSlice() {
    const buffer = this._buffer;
    let offset = 0;
    
    while (offset < buffer.length) {
      const keyInfo = this._readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) { // stringtable field
        const lenInfo = this._readVarint(buffer, offset);
        offset += lenInfo.bytesRead;
        const start = offset;
        const end = offset + lenInfo.value;
        return { start, end };
      } else {
        offset = this._skipField(buffer, offset, wireType);
      }
    }
    return null;
  }

  // Internal generator function to lazily decode the stringtable.
  // Iterates over the raw bytes inside the stringtable and yields decoded strings.
  // The StringTable contains repeated string fields (field number 1, wire type 2).
  *_iterateStringTable() {
    if (!this._stringtableSlice) {
      this._stringtableSlice = this._findStringTableSlice();
    }
    if (!this._stringtableSlice) {
      return; // No stringtable found.
    }
    
    const stBuffer = this._buffer.slice(this._stringtableSlice.start, this._stringtableSlice.end);
    let offset = 0;
    let stringIndex = 0;
    
    while (offset < stBuffer.length) {
      const keyInfo = this._readVarint(stBuffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) { // Each string is in field 1
        const lenInfo = this._readVarint(stBuffer, offset);
        offset += lenInfo.bytesRead;
        const strBytes = stBuffer.slice(offset, offset + lenInfo.value);
        offset += lenInfo.value;
        
        // Yield both the index and the decoded string for debugging/reference
        const decodedString = strBytes.toString('utf8');
        yield { index: stringIndex, value: decodedString };
        stringIndex++;
      } else {
        offset = this._skipField(stBuffer, offset, wireType);
      }
    }
  }

  // Public method: returns an iterable over the strings in the stringtable.
  // Decoding occurs lazily as the iterator is consumed.
  // Each iteration yields the decoded string value.
  iterate_stringtable() {
    return {
      [Symbol.iterator]: () => {
        const generator = this._iterateStringTable();
        return {
          next() {
            const result = generator.next();
            if (result.done) {
              return { done: true };
            }
            // Return just the string value, not the index/value object
            return { value: result.value.value, done: false };
          }
        };
      }
    };
  }

  // Public method: get a string by index from the stringtable (0-based)
  // Returns empty string for index 0, throws error for invalid indices
  // Builds a cache on first access for performance
  getStringByIndex(index) {
    if (!this._stringCache) {
      this._buildStringCache();
    }
    
    if (index < 0 || index >= this._stringCache.length) {
      throw new Error(`StringTable index ${index} out of bounds (length: ${this._stringCache.length})`);
    }
    
    return this._stringCache[index];
  }

  // Internal method to build a complete string cache for fast random access
  _buildStringCache() {
    this._stringCache = [''];  // Index 0 is always empty string
    
    // Iterate through all strings and cache them
    for (const stringEntry of this._iterateStringTable()) {
      this._stringCache.push(stringEntry.value);
    }
  }

  // Public method: get the total number of strings in the stringtable
  getStringCount() {
    if (!this._stringCache) {
      this._buildStringCache();
    }
    return this._stringCache.length;
  }

  // ===== FAST EVENT-DRIVEN PARSER =====
  // This is a separate, optimized implementation that prioritizes speed over robustness.
  // Use the lazy parsing methods above as reference for correctness validation.
  
  // Fast event-driven parser - scans blob data quickly and emits events
  // This is much faster than building full data structures but may be less robust
  fastParse(eventEmitter) {
    const parseStart = this._startTiming();
    
    if (this._timing_verbose) {
      console.log(`[TIMING] Blob ${this._index} - Starting fastParse`);
    }
    
    // Find string table slice
    const stringTableStart = this._startTiming();
    if (!this._stringtableSlice) {
      this._stringtableSlice = this._findStringTableSlice();
    }
    this._endTiming(stringTableStart, 'String table slice location', 'string_table_time');
    
    // Build string lookup table
    const stringBuildStart = this._startTiming();
    const strings = this._buildStringLookup();
    this._endTiming(stringBuildStart, 'String table construction', 'string_table_time');
    
    if (this._timing_verbose) {
      console.log(`[TIMING] Blob ${this._index} - String table size: ${strings.length} strings`);
    }
    
    // Parse primitive groups
    const groupParseStart = this._startTiming();
    let offset = 0;
    const buffer = this._buffer;
    let nodeCount = 0, wayCount = 0, relationCount = 0;
    
    while (offset < buffer.length) {
      try {
        const keyInfo = this._readVarint(buffer, offset);
        const key = keyInfo.value;
        offset += keyInfo.bytesRead;
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (wireType === 2) { // Length-delimited field
          const lenInfo = this._readVarint(buffer, offset);
          offset += lenInfo.bytesRead;
          const fieldData = buffer.slice(offset, offset + lenInfo.value);
          
          // Check field types: All PrimitiveGroups are in field 2
          if (fieldNumber === 2) {
            const groupCounts = this._fastParsePrimitiveGroup(fieldData, strings, eventEmitter);
            nodeCount += groupCounts.nodes;
            wayCount += groupCounts.ways;
            relationCount += groupCounts.relations;
          }
          
          offset += lenInfo.value;
        } else {
          offset = this._skipField(buffer, offset, wireType);
        }
      } catch (e) {
        if (this._timing_verbose) {
          console.log(`[TIMING] Blob ${this._index} - Parse error at offset ${offset}: ${e.message}`);
        }
        break;
      }
    }
    
    this._endTiming(groupParseStart, 'Primitive groups parsing');
    
    // Update counters
    this._performance_stats.total_operations += nodeCount + wayCount + relationCount;
    
    const totalTime = this._endTiming(parseStart, 'Complete blob parsing');
    
    if (this._timing_verbose) {
      console.log(`[TIMING] Blob ${this._index} - Parse summary: ${nodeCount} nodes, ${wayCount} ways, ${relationCount} relations in ${(totalTime/1000000).toFixed(3)}ms`);
    }
    
    // Emit summary event with timing stats
    eventEmitter.emit('blob_complete', {
      index: this._index,
      counts: { nodes: nodeCount, ways: wayCount, relations: relationCount },
      timing: this.getPerformanceStats()
    });
  }
  
  // Fast parse a PrimitiveGroup to determine its content type
  _fastParsePrimitiveGroup(data, strings, eventEmitter) {
    let offset = 0;
    let nodeCount = 0, wayCount = 0, relationCount = 0;
    
    while (offset < data.length) {
      try {
        const keyInfo = this._readVarint(data, offset);
        const key = keyInfo.value;
        offset += keyInfo.bytesRead;
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (wireType === 2) { // Length-delimited field
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          const fieldData = data.slice(offset, offset + lenInfo.value);
          
          // Check content type within PrimitiveGroup
          if (fieldNumber === 2) { // DenseNodes
            const parseStart = this._startTiming();
            const parsed = this._fastParseDenseNodes(fieldData, strings, eventEmitter);
            this._endTiming(parseStart, `Dense nodes (${parsed} nodes)`, 'node_parsing_time');
            nodeCount += parsed;
          } else if (fieldNumber === 3) { // ways[]
            this._fastParseWay(fieldData, strings, eventEmitter);
            wayCount++;
          } else if (fieldNumber === 4) { // relations[]
            this._fastParseRelation(fieldData, strings, eventEmitter);
            relationCount++;
          }
          
          offset += lenInfo.value;
        } else {
          offset = this._skipField(data, offset, wireType);
        }
      } catch (e) {
        if (this._timing_verbose) {
          console.log(`[TIMING] Blob ${this._index} - PrimitiveGroup parse error at offset ${offset}: ${e.message}`);
        }
        break;
      }
    }
    
    return { nodes: nodeCount, ways: wayCount, relations: relationCount };
  }
  
  // Quickly build string lookup table without yielding
  _buildStringLookup() {
    const strings = [''];  // Index 0 is always empty string
    
    if (!this._stringtableSlice) {
      return strings;
    }
    
    const stBuffer = this._buffer.slice(this._stringtableSlice.start, this._stringtableSlice.end);
    let offset = 0;
    
    while (offset < stBuffer.length) {
      const keyInfo = this._readVarint(stBuffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) {
        const lenInfo = this._readVarint(stBuffer, offset);
        offset += lenInfo.bytesRead;
        const strBytes = stBuffer.slice(offset, offset + lenInfo.value);
        offset += lenInfo.value;
        strings.push(strBytes.toString('utf8'));
      } else {
        offset = this._skipField(stBuffer, offset, wireType);
      }
    }
    
    return strings;
  }
  
  // Fast node parsing - minimal object creation
  // Fast parse individual nodes from a PrimitiveGroup field 1 (rarely used)
  _fastParseNodes(data, strings, eventEmitter) {
    let offset = 0;
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) { // Dense nodes
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const denseData = data.slice(offset, offset + lenInfo.value);
        this._fastParseDenseNodes(denseData, strings, eventEmitter);
        offset += lenInfo.value;
      } else if (fieldNumber === 2 && wireType === 2) { // Individual nodes
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const nodeData = data.slice(offset, offset + lenInfo.value);
        this._fastParseNode(nodeData, strings, eventEmitter);
        offset += lenInfo.value;
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
  }
  
  // Fast dense node parsing - processes multiple nodes in packed format
  _fastParseDenseNodes(data, strings, eventEmitter) {
    let offset = 0;
    let ids = [];
    const arrayParseStart = this._startTiming();
    
    // Read the packed arrays
    let lats = [], lons = [], keyvals = [];
    
    // Read the packed arrays
    while (offset < data.length) {
      try {
        const keyInfo = this._readVarint(data, offset);
        const key = keyInfo.value;
        offset += keyInfo.bytesRead;
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (fieldNumber === 1 && wireType === 2) { // id array
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          const arrayEnd = offset + lenInfo.value;
          while (offset < arrayEnd) {
            const idInfo = this._readSignedVarint(data, offset);
            ids.push(idInfo.value);
            offset += idInfo.bytesRead;
          }
        } else if (fieldNumber === 8 && wireType === 2) { // lat array
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          const arrayEnd = offset + lenInfo.value;
          while (offset < arrayEnd) {
            const latInfo = this._readSignedVarint(data, offset);
            lats.push(latInfo.value);
            offset += latInfo.bytesRead;
          }
        } else if (fieldNumber === 9 && wireType === 2) { // lon array
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          const arrayEnd = offset + lenInfo.value;
          while (offset < arrayEnd) {
            const lonInfo = this._readSignedVarint(data, offset);
            lons.push(lonInfo.value);
            offset += lonInfo.bytesRead;
          }
        } else if (fieldNumber === 10 && wireType === 2) { // keys_vals array
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          const arrayEnd = offset + lenInfo.value;
          while (offset < arrayEnd) {
            const kvInfo = this._readVarint(data, offset);
            keyvals.push(kvInfo.value);
            offset += kvInfo.bytesRead;
          }
        } else {
          offset = this._skipField(data, offset, wireType);
        }
      } catch (e) {
        if (this._timing_verbose) {
          console.log(`[TIMING] Blob ${this._index} - Dense nodes array parse error: ${e.message}`);
        }
        break;
      }
    }
    
    this._endTiming(arrayParseStart, `Dense nodes arrays (${ids.length} nodes)`);
    
    // Process nodes with delta decoding - optimized for performance
    const emitStart = this._startTiming();
    let currentId = 0, currentLat = 0, currentLon = 0;
    let kvIndex = 0;
    const nodeCount = ids.length;
    
    const granularity = this._granularity * 0.000000001; // Pre-calculate constant
    const latOffset = this._lat_offset;
    const lonOffset = this._lon_offset;
    
    // Full processing: coordinates + tags
    for (let i = 0; i < nodeCount; i++) {
      currentId += ids[i];
      
      // Decode coordinates
      if (i < lats.length && i < lons.length) {
        currentLat += lats[i];
        currentLon += lons[i];
      }
      
      // Build optimized node object
      const node = {
        id: currentId,
        lat: (latOffset + currentLat) * granularity,
        lon: (lonOffset + currentLon) * granularity,
        tags: {}
      };
      
      // Fast tag parsing from keyvals
      while (kvIndex < keyvals.length && keyvals[kvIndex] !== 0) {
        const keyIdx = keyvals[kvIndex++];
        const valIdx = keyvals[kvIndex++];
        if (keyIdx < strings.length && valIdx < strings.length) {
          node.tags[strings[keyIdx]] = strings[valIdx];
        }
      }
      kvIndex++; // Skip the 0 delimiter
      
      eventEmitter.emit('node', node);
    }
    
    this._endTiming(emitStart, `Dense nodes emission (${nodeCount} nodes)`);
    
    return nodeCount;
  }
  
  // Fast individual node parsing
  _fastParseNode(data, strings, eventEmitter) {
    let offset = 0;
    let id = 0, lat = 0, lon = 0;
    const tags = {};
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 0) { // id
        const idInfo = this._readSignedVarint(data, offset);
        id = idInfo.value;
        offset += idInfo.bytesRead;
      } else if (fieldNumber === 8 && wireType === 0) { // lat
        const latInfo = this._readSignedVarint(data, offset);
        lat = latInfo.value;
        offset += latInfo.bytesRead;
      } else if (fieldNumber === 9 && wireType === 0) { // lon
        const lonInfo = this._readSignedVarint(data, offset);
        lon = lonInfo.value;
        offset += lonInfo.bytesRead;
      } else if (fieldNumber === 2 && wireType === 0) { // key
        const keyInfo = this._readVarint(data, offset);
        offset += keyInfo.bytesRead;
        // Read corresponding value
        const valKeyInfo = this._readVarint(data, offset);
        const valKey = valKeyInfo.value;
        offset += valKeyInfo.bytesRead;
        if (valKey >> 3 === 3) { // field 3 = val
          const valInfo = this._readVarint(data, offset);
          offset += valInfo.bytesRead;
          if (keyInfo.value < strings.length && valInfo.value < strings.length) {
            tags[strings[keyInfo.value]] = strings[valInfo.value];
          }
        }
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
    
    eventEmitter.emit('node', {
      id: id,
      lat: lat * 0.000000001,
      lon: lon * 0.000000001,
      tags: tags
    });
  }
  
  // Fast way parsing
  _fastParseWays(data, strings, eventEmitter) {
    let offset = 0;
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (wireType === 2) {
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const wayData = data.slice(offset, offset + lenInfo.value);
        this._fastParseWay(wayData, strings, eventEmitter);
        offset += lenInfo.value;
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
  }
  
  _fastParseWay(data, strings, eventEmitter) {
    let offset = 0;
    let id = 0;
    
    // Pre-allocate arrays to avoid growth overhead
    let refs = null;
    let refsCount = 0;
    let tags = null;
    const shouldDecodeRefs = this._shouldDecodeReferences();
    const shouldDecodeTags = this._shouldDecodeTags();
    
    // Fast path without exception handling in tight loop
    while (offset < data.length) {
      // Fast varint reading for key (most common case: single byte)
      let key, keyBytes;
      if (data[offset] < 0x80) {
        key = data[offset];
        keyBytes = 1;
      } else {
        const keyInfo = this._readVarint(data, offset);
        key = keyInfo.value;
        keyBytes = keyInfo.bytesRead;
      }
      offset += keyBytes;
      
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 0) { // id
        if (data[offset] < 0x80) {
          id = data[offset];
          offset++;
        } else {
          const idInfo = this._readVarint(data, offset);
          id = idInfo.value;
          offset += idInfo.bytesRead;
        }
      } else if (fieldNumber === 2 && wireType === 0 && shouldDecodeTags) { // key index
        if (!tags) tags = {};
        
        let keyIdx, keyBytes;
        if (data[offset] < 0x80) {
          keyIdx = data[offset];
          keyBytes = 1;
        } else {
          const keyInfo = this._readVarint(data, offset);
          keyIdx = keyInfo.value;
          keyBytes = keyInfo.bytesRead;
        }
        offset += keyBytes;
        
        // Read corresponding value field
        if (offset >= data.length) break;
        
        let valKey, valKeyBytes;
        if (data[offset] < 0x80) {
          valKey = data[offset];
          valKeyBytes = 1;
        } else {
          const valKeyInfo = this._readVarint(data, offset);
          valKey = valKeyInfo.value;
          valKeyBytes = valKeyInfo.bytesRead;
        }
        offset += valKeyBytes;
        
        if ((valKey >> 3) === 3) { // field 3 = val
          let valIdx, valBytes;
          if (data[offset] < 0x80) {
            valIdx = data[offset];
            valBytes = 1;
          } else {
            const valInfo = this._readVarint(data, offset);
            valIdx = valInfo.value;
            valBytes = valInfo.bytesRead;
          }
          offset += valBytes;
          
          if (keyIdx < strings.length && valIdx < strings.length) {
            tags[strings[keyIdx]] = strings[valIdx];
          }
        }
      } else if (fieldNumber === 8 && wireType === 2 && shouldDecodeRefs) { // refs array
        let lenBytes, arrayLen;
        if (data[offset] < 0x80) {
          arrayLen = data[offset];
          lenBytes = 1;
        } else {
          const lenInfo = this._readVarint(data, offset);
          arrayLen = lenInfo.value;
          lenBytes = lenInfo.bytesRead;
        }
        offset += lenBytes;
        
        const arrayEnd = offset + arrayLen;
        let currentRef = 0;
        
        // Pre-allocate refs array with estimated size
        if (!refs) {
          const estimatedCount = Math.max(16, arrayLen >> 2); // Rough estimate
          refs = new Array(estimatedCount);
        }
        
        // Optimized ref delta decoding
        while (offset < arrayEnd) {
          let refDelta, refBytes;
          const firstByte = data[offset];
          
          if (firstByte < 0x80) {
            // Single byte varint (0-127)
            refDelta = firstByte;
            refBytes = 1;
          } else {
            // Multi-byte signed varint
            const refInfo = this._readSignedVarint(data, offset);
            refDelta = refInfo.value;
            refBytes = refInfo.bytesRead;
          }
          
          currentRef += refDelta;
          refs[refsCount++] = currentRef;
          offset += refBytes;
        }
      } else {
        offset = this._skipField(data, offset, wireType);
        if (offset > data.length) break; // Safety check
      }
    }
    
    // Build way object efficiently
    const way = { id: id };
    
    if (shouldDecodeRefs && refs) {
      // Trim array to actual size to save memory
      if (refsCount < refs.length) {
        refs.length = refsCount;
      }
      way.refs = refs;
    }
    
    if (shouldDecodeTags && tags) {
      way.tags = tags;
    }
    
    eventEmitter.emit('way', way);
  }
  
  // Fast relation parsing
  _fastParseRelations(data, strings, eventEmitter) {
    let offset = 0;
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (wireType === 2) {
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const relationData = data.slice(offset, offset + lenInfo.value);
        this._fastParseRelation(relationData, strings, eventEmitter);
        offset += lenInfo.value;
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
  }
  
  _fastParseRelation(data, strings, eventEmitter) {
    let offset = 0;
    let id = 0;
    const members = [];
    const tags = {};
    
    while (offset < data.length) {
      try {
        const keyInfo = this._readVarint(data, offset);
        const key = keyInfo.value;
        offset += keyInfo.bytesRead;
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (fieldNumber === 1 && wireType === 0) { // id
          const idInfo = this._readVarint(data, offset);
          id = idInfo.value;
          offset += idInfo.bytesRead;
        } else if (fieldNumber === 2 && wireType === 0 && this._shouldDecodeTags()) { // key index
          const keyInfo = this._readVarint(data, offset);
          offset += keyInfo.bytesRead;
          // Read corresponding value
          const valKeyInfo = this._readVarint(data, offset);
          const valKey = valKeyInfo.value;
          offset += valKeyInfo.bytesRead;
          if (valKey >> 3 === 3) { // field 3 = val
            const valInfo = this._readVarint(data, offset);
            offset += valInfo.bytesRead;
            if (keyInfo.value < strings.length && valInfo.value < strings.length) {
              tags[strings[keyInfo.value]] = strings[valInfo.value];
            }
          }
        } else if (fieldNumber === 8 && wireType === 2 && this._shouldDecodeReferences()) { // memids
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          const arrayEnd = offset + lenInfo.value;
          let currentMemId = 0;
          while (offset < arrayEnd) {
            const memInfo = this._readSignedVarint(data, offset);
            currentMemId += memInfo.value;
            members.push({ ref: currentMemId });
            offset += memInfo.bytesRead;
          }
        } else {
          offset = this._skipField(data, offset, wireType);
        }
      } catch (e) {
        if (this._timing_verbose) {
          console.log(`[TIMING] Blob ${this._index} - Relation parse error: ${e.message}`);
        }
        break;
      }
    }
    
    // Build relation object based on decode mode
    const relation = { id: id };
    
    if (this._shouldDecodeReferences()) {
      relation.members = members;
    }
    
    if (this._shouldDecodeTags()) {
      relation.tags = tags;
    }
    
    eventEmitter.emit('relation', relation);
  }
  


  // ===== LAZY PARSING METHODS (SLOW/RELIABLE) =====
  // These methods provide lazy iteration through blob content without building large data structures
  
  // Public method: returns an iterable over nodes in the blob
  // Yields node objects with { id, lat, lon, tags } - performs lazy parsing
  *iterateNodes() {
    const strings = this._getStringCache();
    let offset = 0;
    const buffer = this._buffer;
    
    while (offset < buffer.length) {
      const keyInfo = this._readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 2 && wireType === 2) { // PrimitiveGroup with nodes
        const lenInfo = this._readVarint(buffer, offset);
        offset += lenInfo.bytesRead;
        const primitiveGroupData = buffer.slice(offset, offset + lenInfo.value);
        
        // Parse this primitive group for nodes
        yield* this._parseNodesFromPrimitiveGroup(primitiveGroupData, strings);
        
        offset += lenInfo.value;
      } else {
        offset = this._skipField(buffer, offset, wireType);
      }
    }
  }

  // Public method: returns an iterable over ways in the blob
  *iterateWays() {
    const strings = this._getStringCache();
    let offset = 0;
    const buffer = this._buffer;
    
    while (offset < buffer.length) {
      const keyInfo = this._readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 2 && wireType === 2) { // PrimitiveGroup
        const lenInfo = this._readVarint(buffer, offset);
        offset += lenInfo.bytesRead;
        const primitiveGroupData = buffer.slice(offset, offset + lenInfo.value);
        
        // Parse this primitive group for ways
        yield* this._parseWaysFromPrimitiveGroup(primitiveGroupData, strings);
        
        offset += lenInfo.value;
      } else {
        offset = this._skipField(buffer, offset, wireType);
      }
    }
  }

  // Public method: returns an iterable over relations in the blob
  *iterateRelations() {
    const strings = this._getStringCache();
    let offset = 0;
    const buffer = this._buffer;
    
    while (offset < buffer.length) {
      const keyInfo = this._readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 2 && wireType === 2) { // PrimitiveGroup
        const lenInfo = this._readVarint(buffer, offset);
        offset += lenInfo.bytesRead;
        const primitiveGroupData = buffer.slice(offset, offset + lenInfo.value);
        
        // Parse this primitive group for relations
        yield* this._parseRelationsFromPrimitiveGroup(primitiveGroupData, strings);
        
        offset += lenInfo.value;
      } else {
        offset = this._skipField(buffer, offset, wireType);
      }
    }
  }

  // Helper method to get string cache, building it if needed
  _getStringCache() {
    if (!this._stringCache) {
      this._buildStringCache();
    }
    return this._stringCache;
  }

  // Parse nodes from a PrimitiveGroup buffer
  *_parseNodesFromPrimitiveGroup(data, strings) {
    let offset = 0;
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 2 && wireType === 2) { // Dense nodes
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const denseData = data.slice(offset, offset + lenInfo.value);
        yield* this._parseDenseNodesLazy(denseData, strings);
        offset += lenInfo.value;
      } else if (fieldNumber === 1 && wireType === 2) { // Individual nodes
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const nodeData = data.slice(offset, offset + lenInfo.value);
        yield this._parseIndividualNodeLazy(nodeData, strings);
        offset += lenInfo.value;
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
  }

  // Parse dense nodes lazily (most common case)
  *_parseDenseNodesLazy(data, strings) {
    let offset = 0;
    let ids = [], lats = [], lons = [], keyvals = [];
    
    // Read the packed arrays
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) { // id array
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const arrayEnd = offset + lenInfo.value;
        while (offset < arrayEnd) {
          const idInfo = this._readSignedVarint(data, offset);
          ids.push(idInfo.value);
          offset += idInfo.bytesRead;
        }
      } else if (fieldNumber === 8 && wireType === 2) { // lat array
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const arrayEnd = offset + lenInfo.value;
        while (offset < arrayEnd) {
          const latInfo = this._readSignedVarint(data, offset);
          lats.push(latInfo.value);
          offset += latInfo.bytesRead;
        }
      } else if (fieldNumber === 9 && wireType === 2) { // lon array
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const arrayEnd = offset + lenInfo.value;
        while (offset < arrayEnd) {
          const lonInfo = this._readSignedVarint(data, offset);
          lons.push(lonInfo.value);
          offset += lonInfo.bytesRead;
        }
      } else if (fieldNumber === 10 && wireType === 2) { // keys_vals array
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const arrayEnd = offset + lenInfo.value;
        while (offset < arrayEnd) {
          const kvInfo = this._readVarint(data, offset);
          keyvals.push(kvInfo.value);
          offset += kvInfo.bytesRead;
        }
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
    
    // Process nodes with delta decoding, yielding one at a time
    let currentId = 0, currentLat = 0, currentLon = 0;
    let kvIndex = 0;
    
    for (let i = 0; i < ids.length; i++) {
      currentId += ids[i];
      currentLat += lats[i];
      currentLon += lons[i];
      
      // Build tags object
      const tags = {};
      while (kvIndex < keyvals.length && keyvals[kvIndex] !== 0) {
        const keyIdx = keyvals[kvIndex++];
        const valIdx = keyvals[kvIndex++];
        if (keyIdx < strings.length && valIdx < strings.length) {
          tags[strings[keyIdx]] = strings[valIdx];
        }
      }
      kvIndex++; // Skip the 0 delimiter
      
      yield {
        id: currentId,
        lat: (this._lat_offset + currentLat) * this._granularity * 0.000000001, // Convert to degrees
        lon: (this._lon_offset + currentLon) * this._granularity * 0.000000001,
        tags: tags
      };
    }
  }

  // Parse individual node lazily
  _parseIndividualNodeLazy(data, strings) {
    let offset = 0;
    let id = 0, lat = 0, lon = 0;
    const tags = {};
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 0) { // id
        const idInfo = this._readSignedVarint(data, offset);
        id = idInfo.value;
        offset += idInfo.bytesRead;
      } else if (fieldNumber === 8 && wireType === 0) { // lat
        const latInfo = this._readSignedVarint(data, offset);
        lat = latInfo.value;
        offset += latInfo.bytesRead;
      } else if (fieldNumber === 9 && wireType === 0) { // lon
        const lonInfo = this._readSignedVarint(data, offset);
        lon = lonInfo.value;
        offset += lonInfo.bytesRead;
      } else if (fieldNumber === 2 && wireType === 0) { // key index
        const keyInfo = this._readVarint(data, offset);
        const keyIdx = keyInfo.value;
        offset += keyInfo.bytesRead;
        // Read corresponding value
        if (offset < data.length) {
          const valKeyInfo = this._readVarint(data, offset);
          const valKey = valKeyInfo.value;
          offset += valKeyInfo.bytesRead;
          if ((valKey >> 3) === 3) { // field 3 = val
            const valInfo = this._readVarint(data, offset);
            const valIdx = valInfo.value;
            offset += valInfo.bytesRead;
            if (keyIdx < strings.length && valIdx < strings.length) {
              tags[strings[keyIdx]] = strings[valIdx];
            }
          }
        }
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
    
    return {
      id: id,
      lat: (this._lat_offset + lat) * this._granularity * 0.000000001,
      lon: (this._lon_offset + lon) * this._granularity * 0.000000001,
      tags: tags
    };
  }

  // Parse ways from a PrimitiveGroup buffer
  *_parseWaysFromPrimitiveGroup(data, strings) {
    let offset = 0;
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 3 && wireType === 2) { // Field 3 = ways[]
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const wayData = data.slice(offset, offset + lenInfo.value);
        yield this._parseWayLazy(wayData, strings);
        offset += lenInfo.value;
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
  }

  // Parse relations from a PrimitiveGroup buffer
  *_parseRelationsFromPrimitiveGroup(data, strings) {
    let offset = 0;
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 4 && wireType === 2) { // Field 4 = relations[]
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const relationData = data.slice(offset, offset + lenInfo.value);
        yield this._parseRelationLazy(relationData, strings);
        offset += lenInfo.value;
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
  }

  // Parse individual way lazily
  _parseWayLazy(data, strings) {
    let offset = 0;
    let id = 0;
    const refs = [];
    const tags = {};
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 0) { // id
        const idInfo = this._readVarint(data, offset);
        id = idInfo.value;
        offset += idInfo.bytesRead;
      } else if (fieldNumber === 2 && wireType === 0) { // key index
        const keyInfo = this._readVarint(data, offset);
        const keyIdx = keyInfo.value;
        offset += keyInfo.bytesRead;
        // Read corresponding value
        if (offset < data.length) {
          const valKeyInfo = this._readVarint(data, offset);
          const valKey = valKeyInfo.value;
          offset += valKeyInfo.bytesRead;
          if ((valKey >> 3) === 3) { // field 3 = val
            const valInfo = this._readVarint(data, offset);
            const valIdx = valInfo.value;
            offset += valInfo.bytesRead;
            if (keyIdx < strings.length && valIdx < strings.length) {
              tags[strings[keyIdx]] = strings[valIdx];
            }
          }
        }
      } else if (fieldNumber === 8 && wireType === 2) { // refs array
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const arrayEnd = offset + lenInfo.value;
        let currentRef = 0;
        while (offset < arrayEnd) {
          const refInfo = this._readSignedVarint(data, offset);
          currentRef += refInfo.value;
          refs.push(currentRef);
          offset += refInfo.bytesRead;
        }
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
    
    return {
      id: id,
      refs: refs,
      tags: tags
    };
  }
  
  // Parse individual relation lazily
  _parseRelationLazy(data, strings) {
    let offset = 0;
    let id = 0;
    const members = [];
    const tags = {};
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 0) { // id
        const idInfo = this._readVarint(data, offset);
        id = idInfo.value;
        offset += idInfo.bytesRead;
      } else if (fieldNumber === 2 && wireType === 0) { // key index
        const keyInfo = this._readVarint(data, offset);
        const keyIdx = keyInfo.value;
        offset += keyInfo.bytesRead;
        // Read corresponding value
        if (offset < data.length) {
          const valKeyInfo = this._readVarint(data, offset);
          const valKey = valKeyInfo.value;
          offset += valKeyInfo.bytesRead;
          if ((valKey >> 3) === 3) { // field 3 = val
            const valInfo = this._readVarint(data, offset);
            const valIdx = valInfo.value;
            offset += valInfo.bytesRead;
            if (keyIdx < strings.length && valIdx < strings.length) {
              tags[strings[keyIdx]] = strings[valIdx];
            }
          }
        }
      } else if (fieldNumber === 9 && wireType === 2) { // memids
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        const arrayEnd = offset + lenInfo.value;
        let currentMemId = 0;
        while (offset < arrayEnd) {
          const memInfo = this._readSignedVarint(data, offset);
          currentMemId += memInfo.value;
          members.push({ ref: currentMemId });
          offset += memInfo.bytesRead;
        }
      } else {
        offset = this._skipField(data, offset, wireType);
      }
    }
    
    return {
      id: id,
      members: members,
      tags: tags
    };
  }

  // Internal method to parse block properties (granularity, offsets)
  _parseBlockProperties() {
    const buffer = this._buffer;
    let offset = 0;
    
    while (offset < buffer.length) {
      const keyInfo = this._readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (wireType === 0) { // Varint fields
        const valueInfo = this._readVarint(buffer, offset);
        offset += valueInfo.bytesRead;
        
        switch (fieldNumber) {
          case 17: // granularity
            this._granularity = valueInfo.value;
            break;
          case 18: // date_granularity
            this._date_granularity = valueInfo.value;
            break;
          case 19: // lat_offset
            this._lat_offset = this._readSignedVarint(buffer, offset - valueInfo.bytesRead).value;
            break;
          case 20: // lon_offset
            this._lon_offset = this._readSignedVarint(buffer, offset - valueInfo.bytesRead).value;
            break;
        }
      } else {
        offset = this._skipField(buffer, offset, wireType);
      }
    }
  }

  // Debug method to analyze the raw structure of a blob
  analyzeRawStructure() {
    const buffer = this._buffer;
    let offset = 0;
    const analysis = {
      totalSize: buffer.length,
      fields: [],
      errors: []
    };
    
    try {
      while (offset < buffer.length && analysis.fields.length < 50) { // Limit to avoid overwhelming output
        const keyInfo = this._readVarint(buffer, offset);
        const key = keyInfo.value;
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        const fieldAnalysis = {
          offset: offset,
          fieldNumber: fieldNumber,
          wireType: wireType,
          key: key
        };
        
        offset += keyInfo.bytesRead;
        
        try {
          switch (wireType) {
            case 0: { // Varint
              const varint = this._readVarint(buffer, offset);
              fieldAnalysis.value = varint.value;
              fieldAnalysis.size = varint.bytesRead;
              offset += varint.bytesRead;
              break;
            }
            case 1: { // 64-bit
              fieldAnalysis.size = 8;
              offset += 8;
              break;
            }
            case 2: { // Length-delimited
              const lenVar = this._readVarint(buffer, offset);
              fieldAnalysis.size = lenVar.bytesRead + lenVar.value;
              fieldAnalysis.length = lenVar.value;
              offset += lenVar.bytesRead + lenVar.value;
              break;
            }
            case 5: { // 32-bit
              fieldAnalysis.size = 4;
              offset += 4;
              break;
            }
            default: {
              fieldAnalysis.error = `Unknown wire type ${wireType}`;
              analysis.errors.push(`Unknown wire type ${wireType} at offset ${offset-keyInfo.bytesRead}`);
              offset += 1; // Skip one byte and try to continue
              break;
            }
          }
        } catch (e) {
          fieldAnalysis.error = e.message;
          analysis.errors.push(`Error parsing field at offset ${offset-keyInfo.bytesRead}: ${e.message}`);
          offset += 1; // Skip one byte and try to continue
        }
        
        analysis.fields.push(fieldAnalysis);
      }
    } catch (e) {
      analysis.errors.push(`Fatal error during analysis: ${e.message}`);
    }
    
    return analysis;
 }

  // Fast element counting without full iteration (for performance)
  getElementCounts() {
    // For now, use the fallback method since fast parsing requires more infrastructure
    return this.getElementCountsFallback();
  }
  
  // Fallback element counting method
  getElementCountsFallback() {
    const counts = { nodes: 0, ways: 0, relations: 0 };
    
    try {
      // Count using existing iteration methods with limits
      let nodeCount = 0;
      for (const node of this.iterateNodes()) {
        nodeCount++;
        if (nodeCount >= 50000) break; // Reasonable limit for quick counting
      }
      counts.nodes = nodeCount;
      
      let wayCount = 0;
      for (const way of this.iterateWays()) {
        wayCount++;
        if (wayCount >= 10000) break; // Reasonable limit for quick counting
      }
      counts.ways = wayCount;
      
      let relationCount = 0;
      for (const relation of this.iterateRelations()) {
        relationCount++;
        if (relationCount >= 5000) break; // Reasonable limit for quick counting
      }
      counts.relations = relationCount;
      
    } catch (err) {
      console.warn(`Element counting failed for blob ${this.index}: ${err.message}`);
    }
    
    return counts;
  }
  
  // Fast method to extract raw string table data without decoding UTF-8
  _extractRawStringTable() {
    if (!this._stringtableSlice) {
      this._stringtableSlice = this._findStringTableSlice();
    }
    if (!this._stringtableSlice) {
      return null;
    }
    
    return {
      buffer: this._buffer.slice(this._stringtableSlice.start, this._stringtableSlice.end),
      start: this._stringtableSlice.start,
      end: this._stringtableSlice.end
    };
  }
  
  // Fast method to extract coordinate scaling info
  _getCoordinateInfo() {
    const buffer = this._buffer;
    let offset = 0;
    let granularity = 100; // default
    let latOffset = 0;     // default
    let lonOffset = 0;     // default
    
    // Quick scan for coordinate fields without full parsing
    while (offset < buffer.length) {
      try {
        const keyInfo = this._readVarint(buffer, offset);
        const key = keyInfo.value;
        offset += keyInfo.bytesRead;
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (fieldNumber === 17 && wireType === 0) { // granularity
          const granularityInfo = this._readVarint(buffer, offset);
          granularity = granularityInfo.value;
          offset += granularityInfo.bytesRead;
        } else if (fieldNumber === 19 && wireType === 0) { // lat_offset
          const latInfo = this._readVarint(buffer, offset);
          latOffset = latInfo.value;
          offset += latInfo.bytesRead;
        } else if (fieldNumber === 20 && wireType === 0) { // lon_offset
          const lonInfo = this._readVarint(buffer, offset);
          lonOffset = lonInfo.value;
          offset += lonInfo.bytesRead;
        } else {
          offset = this._skipField(buffer, offset, wireType);
        }
      } catch (e) {
        break; // Stop on any parsing error
      }
    }
    
    return { granularity, latOffset, lonOffset };
  }
  
  // Fast method to extract raw primitive group buffers without parsing contents
  _extractRawPrimitiveGroups() {
    const buffer = this._buffer;
    let offset = 0;
    const primitiveGroups = [];
    
    while (offset < buffer.length) {
      try {
        const keyInfo = this._readVarint(buffer, offset);
        const key = keyInfo.value;
        offset += keyInfo.bytesRead;
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (fieldNumber === 2 && wireType === 2) { // PrimitiveGroup field
          const lenInfo = this._readVarint(buffer, offset);
          offset += lenInfo.bytesRead;
          const groupStart = offset;
          const groupEnd = offset + lenInfo.value;
          
          // Extract the raw primitive group buffer
          primitiveGroups.push({
            buffer: buffer.slice(groupStart, groupEnd),
            start: groupStart,
            end: groupEnd,
            type: this._detectPrimitiveGroupType(buffer, groupStart, groupEnd)
          });
          
          offset = groupEnd;
        } else {
          offset = this._skipField(buffer, offset, wireType);
        }
      } catch (e) {
        break; // Stop on any parsing error
      }
    }
    
    return primitiveGroups;
  }
  
  // Quick detection of primitive group type without full parsing
  _detectPrimitiveGroupType(buffer, start, end) {
    let offset = start;
    let hasNodes = false, hasWays = false, hasRelations = false, hasDenseNodes = false;
    
    while (offset < end && offset < start + 100) { // Only scan first 100 bytes for performance
      try {
        const keyInfo = this._readVarint(buffer, offset);
        const key = keyInfo.value;
        offset += keyInfo.bytesRead;
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (fieldNumber === 1) hasNodes = true;
        else if (fieldNumber === 2) hasDenseNodes = true;
        else if (fieldNumber === 3) hasWays = true;
        else if (fieldNumber === 4) hasRelations = true;
        
        offset = this._skipField(buffer, offset, wireType);
      } catch (e) {
        break;
      }
    }
    
    // Return the primary type found
    if (hasDenseNodes) return 'dense-nodes';
    if (hasNodes) return 'nodes';
    if (hasWays) return 'ways';
    if (hasRelations) return 'relations';
    return 'unknown';
  }
  
  // Timing and performance logging methods
  _logTiming(operation, nanoseconds) {
    if (this._timing_verbose) {
      const milliseconds = nanoseconds / 1000000;
      console.log(`[TIMING] Blob ${this._index} - ${operation}: ${milliseconds.toFixed(3)}ms`);
    }
  }
  
  _startTiming() {
    return this._timing_verbose ? process.hrtime.bigint() : null;
  }
  
  _endTiming(startTime, operation, statsKey) {
    if (this._timing_verbose && startTime) {
      const duration = Number(process.hrtime.bigint() - startTime);
      if (statsKey && this._performance_stats[statsKey] !== undefined) {
        this._performance_stats[statsKey] += duration;
      }
      this._logTiming(operation, duration);
      return duration;
    }
    return 0;
  }
  
  // Get comprehensive performance statistics
  getPerformanceStats() {
    const stats = { ...this._performance_stats };
    
    // Convert nanoseconds to milliseconds for readability
    Object.keys(stats).forEach(key => {
      if (typeof stats[key] === 'number') {
        stats[key] = stats[key] / 1000000; // Convert to milliseconds
      }
    });
    
    // Calculate total time
    stats.total_parsing_time = stats.string_table_time + stats.node_parsing_time + 
                               stats.way_parsing_time + stats.relation_parsing_time;
    
    return stats;
  }
  
  // Reset performance statistics
  resetPerformanceStats() {
    Object.keys(this._performance_stats).forEach(key => {
      this._performance_stats[key] = 0;
    });
  }

  // Helper methods for parsing decisions (always true for full parsing)
  _shouldDecodeReferences() {
    return true;
  }
  
  _shouldDecodeTags() {
    return true;
  }
  
  _shouldEmitTags() {
    return true;
  }

}

module.exports = OSM_Blob;
