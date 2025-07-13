/*
OSM_PBF_Parser_Decode:
• Extends OSM_PBF_Parser_Decompress.
• Listens for 'blob-decompressed' events.
• For each decompressed blob, creates an OSM_Blob instance (using the decompressed data and blob index).
• Raises a 'blob-ready' event carrying the new OSM_Blob instance.
• Blob limiting (e.g. maxBlobLimit) is handled entirely within the Core_Read class.
• Includes simple driver code for standalone execution.
*/
const OSM_PBF_Parser_Decompress = require('./OSM_PBF_Parser_Decompress.js');
const OSM_Blob = require('./OSM_Blob.js');

class OSM_PBF_Parser_Decode extends OSM_PBF_Parser_Decompress {
  constructor(file_path, options = {}) {
    super(file_path, options);
    this.fastMode = options.fastMode || false;
    this.emitRawData = options.emitRawData || false;
    this.read_threshold = options.read_threshold !== undefined ? options.read_threshold : (24 * 1024 * 1024 * 1024); // 24GB default, null = no limit
    
    // Timing configuration
    this.timing_verbose = options.timing_verbose || false;
    
    // Cache for performance optimizations
    this._blobInstanceCache = new Map();
    this._lastProgressTime = 0;
    this._progressThrottleMs = 1000; // Only update progress every 1 second
    
    if (this.timing_verbose) {
      console.log(`[TIMING] Decoder initialized with timing_verbose: ${this.timing_verbose}`);
    }
    
    // Note: The maxBlobLimit option is handled in the Core_Read class.
    this.on('blob-decompressed', (event) => {
      // Early exit if parser is stopped
      if (this._stopped_manually || this._threshold_reached) {
        return;
      }
      
      const blobProcessingStart = this.fastMode ? process.hrtime.bigint() : null;
      
      try {
        // In fast mode, create a lightweight blob instance for counting only
        const blobInstance = this.fastMode ? 
          this._createFastBlob(event) : 
          new OSM_Blob({
            index: event.blobIndex,
            data: event.decompressedData,
            timing_verbose: this.timing_verbose
          });

        // In fast mode, emit raw decoded primitives immediately
        if (this.fastMode && event.blobType === 'OSMData') {
          this._emitRawPrimitives(blobInstance, event);
        }

        this.raise('blob-ready', {
          blob: blobInstance,
          blobIndex: event.blobIndex,
          input_chunk_index: event.input_chunk_index,
          globalDataStart: event.globalDataStart,
          blobType: event.blobType || 'unknown' // Pass through blob type if available
        });
        
        if (this.fastMode && blobProcessingStart) {
          const blobProcessingTime = process.hrtime.bigint() - blobProcessingStart;
          this.raise('performance-data', {
            blobIndex: event.blobIndex,
            blobProcessingTime: Number(blobProcessingTime),
            bufferSize: event.decompressedData.length
          });
        }
      } catch (err) {
        this.raise('error', new Error(`Error encapsulating blob ${event.blobIndex}: ${err.message}`));
      }
    });
  }
  
  // Fast method to create lightweight blob instances for fast mode
  _createFastBlob(event) {
    // Create a minimal blob instance that only supports the methods we need for fast counting
    return new OSM_Blob({
      index: event.blobIndex,
      data: event.decompressedData,
      timing_verbose: this.timing_verbose
    });
  }

  // Fast method to emit raw primitive group data without creating full JS objects
  _emitRawPrimitives(blob, event) {
    try {
      const rawPrimitives = blob._extractRawPrimitiveGroups();
      this.raise('raw-primitives', {
        blobIndex: event.blobIndex,
        blobType: event.blobType,
        stringTable: blob._extractRawStringTable(),
        primitiveGroups: rawPrimitives,
        coordinateInfo: blob._getCoordinateInfo()
      });
    } catch (err) {
      // Fallback gracefully if raw extraction fails
      console.warn(`Fast primitive extraction failed for blob ${event.blobIndex}: ${err.message}`);
    }
  }
  
  // Use the decompression chain's parse() method.
  parse() {
    super.parse();
  }
}

module.exports = OSM_PBF_Parser_Decode;

// Detailed analysis function for debugging and validation
function runDetailedAnalysis(filePath, maxBlobs = 3, read_threshold = null) {
  console.log('🔍 RUNNING DETAILED ANALYSIS');
  console.log('═'.repeat(80));
  
  const parser = new OSM_PBF_Parser_Decode(filePath, { 
    verbose: true, 
    highWaterMark: 4 * 1024 * 1024,
    maxBlobLimit: maxBlobs,
    read_threshold: read_threshold
  });
  
  // Set global reference for cleanup
  if (typeof global !== 'undefined') global.currentParser = parser;
  
  let totalNodes = 0, totalWays = 0, totalRelations = 0;
  let blobCount = 0;
  
  // Reference data from pbfParser for comparison
  let referenceBlobData = [];
  
  parser.on('start', (event) => {
    console.log(`Started reading ${event.file_path} (size: ${event.file_size} bytes)...`);
    console.log('═'.repeat(80));
  });
  
  parser.on('blob-ready', (event) => {
    // Stop processing blobs if parser has been stopped or threshold reached
    if (parser._stopped_manually || parser._threshold_reached) {
      return;
    }
    
    const blobProcessingStart = process.hrtime.bigint();
    blobCount++;
    const blob = event.blob;
    const blobType = event.blobType || 'unknown';
    
    console.log(`\n📦 BLOB ${event.blobIndex} ANALYSIS (Type: ${blobType})`);
    console.log('─'.repeat(50));
    
    // Only analyze OSMData blobs, skip OSMHeader blobs
    if (blobType !== 'OSMData') {
      console.log(`⏭️  Skipping non-OSMData blob (type: ${blobType})`);
      console.log(`💾 Blob ${event.blobIndex} buffer size: ${blob.buffer.length} bytes`);
      return;
    }
    
    // REFERENCE COMPARISON (if available)
    const referenceData = referenceBlobData[event.blobIndex];
    if (referenceData) {
      console.log(`\n📚 REFERENCE DATA (from pbfParser):`);
      console.log(`   📊 Expected: ${referenceData.nodes} nodes, ${referenceData.ways} ways, ${referenceData.relations} relations`);
      console.log(`   🔤 String table: ${referenceData.stringCount} strings`);
      if (referenceData.sampleStrings && referenceData.sampleStrings.length > 0) {
        console.log(`   📝 Sample strings: ${referenceData.sampleStrings.slice(0, 5).map(s => `"${s}"`).join(', ')}`);
      }
      if (referenceData.sampleNode) {
        const n = referenceData.sampleNode;
        console.log(`   📍 Sample node: ID=${n.id}, lat=${n.lat.toFixed(6)}, lon=${n.lon.toFixed(6)}, tags=${Object.keys(n.tags || {}).length}`);
      }
    }
    
    // Add raw structure analysis for debugging (only for first few blobs)
    if (event.blobIndex <= 2) {
      console.log(`\n🔍 RAW STRUCTURE ANALYSIS:`);
      const analysis = blob.analyzeRawStructure();
      console.log(`   Total size: ${analysis.totalSize} bytes`);
      console.log(`   Fields found: ${analysis.fields.length}`);
      if (analysis.errors.length > 0) {
        console.log(`   Errors: ${analysis.errors.length}`);
        analysis.errors.slice(0, 5).forEach(err => console.log(`     - ${err}`));
      }
      
      // Show first few fields
      analysis.fields.slice(0, 10).forEach((field, i) => {
        const errorStr = field.error ? ` ERROR: ${field.error}` : '';
        console.log(`   [${i}] Field ${field.fieldNumber}, wire ${field.wireType}, offset ${field.offset}${errorStr}`);
      });
    }
    
    // 1. STRING TABLE ANALYSIS
    const stringTableStart = process.hrtime.bigint();
    const stringCount = blob.getStringCount();
    const stringTableTime = process.hrtime.bigint() - stringTableStart;
    console.log(`\n🔤 OUR STRING TABLE ANALYSIS:`);
    console.log(`   📊 Found: ${stringCount} strings`);
    console.log(`   ⏱️  String count time: ${stringTableTime}ns (${Number(stringTableTime) / 1000000}ms)`);
    
    // Show sample strings
    if (stringCount > 0) {
      const sampleStringStart = process.hrtime.bigint();
      console.log(`   Sample strings:`);
      for (let i = 0; i < Math.min(10, stringCount); i++) {
        try {
          const str = blob.getStringByIndex(i);
          const display = str.length > 30 ? str.substring(0, 30) + '...' : str;
          console.log(`   [${i}] "${display}"`);
        } catch (e) {
          console.log(`   [${i}] <error: ${e.message}>`);
        }
      }
      const sampleStringTime = process.hrtime.bigint() - sampleStringStart;
      console.log(`   ⏱️  Sample string extraction time: ${sampleStringTime}ns (${Number(sampleStringTime) / 1000000}ms)`);
    }
    
    // Compare with reference
    if (referenceData) {
      const stringMatch = stringCount === referenceData.stringCount;
      console.log(`   🎯 String count match: ${stringMatch ? '✓' : '✗'} (ours: ${stringCount}, ref: ${referenceData.stringCount})`);
    }
    
    // 2. LAZY PARSING ANALYSIS
    console.log(`\n🔍 LAZY PARSING ANALYSIS:`);
    
    // Count nodes using lazy iteration
    let nodeCount = 0, sampleNode = null;
    const nodeIterationStart = process.hrtime.bigint();
    try {
      for (const node of blob.iterateNodes()) {
        if (nodeCount === 0) sampleNode = node;
        nodeCount++;
        if (nodeCount >= 1000) break; // Limit for performance
      }
      totalNodes += nodeCount;
      const nodeIterationTime = process.hrtime.bigint() - nodeIterationStart;
      console.log(`   📍 Nodes: ${nodeCount}${nodeCount >= 1000 ? '+' : ''}`);
      console.log(`   ⏱️  Node iteration time: ${nodeIterationTime}ns (${Number(nodeIterationTime) / 1000000}ms)`);
      if (sampleNode) {
        console.log(`     Sample: ID=${sampleNode.id}, lat=${sampleNode.lat.toFixed(6)}, lon=${sampleNode.lon.toFixed(6)}`);
        const tagCount = Object.keys(sampleNode.tags).length;
        console.log(`     Tags: ${tagCount} (${Object.keys(sampleNode.tags).slice(0, 3).join(', ')}${tagCount > 3 ? '...' : ''})`);
      }
    } catch (e) {
      const nodeIterationTime = process.hrtime.bigint() - nodeIterationStart;
      console.log(`   📍 Nodes: Error - ${e.message}`);
      console.log(`   ⏱️  Node iteration time (error): ${nodeIterationTime}ns (${Number(nodeIterationTime) / 1000000}ms)`);
    }
    
    // Count ways using lazy iteration
    let wayCount = 0, sampleWay = null;
    const wayIterationStart = process.hrtime.bigint();
    try {
      for (const way of blob.iterateWays()) {
        if (wayCount === 0) sampleWay = way;
        wayCount++;
        if (wayCount >= 500) break; // Limit for performance
      }
      totalWays += wayCount;
      const wayIterationTime = process.hrtime.bigint() - wayIterationStart;
      console.log(`   🛣️  Ways: ${wayCount}${wayCount >= 500 ? '+' : ''}`);
      console.log(`   ⏱️  Way iteration time: ${wayIterationTime}ns (${Number(wayIterationTime) / 1000000}ms)`);
      if (sampleWay) {
        console.log(`     Sample: ID=${sampleWay.id}, refs=${sampleWay.refs.length} nodes`);
        const tagCount = Object.keys(sampleWay.tags).length;
        console.log(`     Tags: ${tagCount} (${Object.keys(sampleWay.tags).slice(0, 3).join(', ')}${tagCount > 3 ? '...' : ''})`);
      }
    } catch (e) {
      const wayIterationTime = process.hrtime.bigint() - wayIterationStart;
      console.log(`   🛣️  Ways: Error - ${e.message}`);
      console.log(`   ⏱️  Way iteration time (error): ${wayIterationTime}ns (${Number(wayIterationTime) / 1000000}ms)`);
    }
    
    // Count relations using lazy iteration
    let relationCount = 0, sampleRelation = null;
    const relationIterationStart = process.hrtime.bigint();
    try {
      for (const relation of blob.iterateRelations()) {
        if (relationCount === 0) sampleRelation = relation;
        relationCount++;
        if (relationCount >= 100) break; // Limit for performance
      }
      totalRelations += relationCount;
      const relationIterationTime = process.hrtime.bigint() - relationIterationStart;
      console.log(`   🔗 Relations: ${relationCount}${relationCount >= 100 ? '+' : ''}`);
      console.log(`   ⏱️  Relation iteration time: ${relationIterationTime}ns (${Number(relationIterationTime) / 1000000}ms)`);
      if (sampleRelation) {
        console.log(`     Sample: ID=${sampleRelation.id}, members=${sampleRelation.members.length}`);
        const tagCount = Object.keys(sampleRelation.tags).length;
        console.log(`     Tags: ${tagCount} (${Object.keys(sampleRelation.tags).slice(0, 3).join(', ')}${tagCount > 3 ? '...' : ''})`);
      }
    } catch (e) {
      const relationIterationTime = process.hrtime.bigint() - relationIterationStart;
      console.log(`   🔗 Relations: Error - ${e.message}`);
      console.log(`   ⏱️  Relation iteration time (error): ${relationIterationTime}ns (${Number(relationIterationTime) / 1000000}ms)`);
    }
    
    // 3. FAST EVENT-DRIVEN PARSING ANALYSIS (if we have time and the blob isn't huge)
    if (nodeCount < 10000) { // Only for smaller blobs to avoid overwhelming output
      console.log(`\n⚡ FAST EVENT-DRIVEN PARSER TEST:`);
      
      const EventEmitter = require('events');
      const emitter = new EventEmitter();
      
      let fastNodeCount = 0, fastWayCount = 0, fastRelationCount = 0;
      let fastSampleNode = null, fastSampleWay = null, fastSampleRelation = null;
      
      emitter.on('node', (node) => {
        if (fastNodeCount === 0) fastSampleNode = node;
        fastNodeCount++;
      });
      
      emitter.on('way', (way) => {
        if (fastWayCount === 0) fastSampleWay = way;
        fastWayCount++;
      });
      
      emitter.on('relation', (relation) => {
        if (fastRelationCount === 0) fastSampleRelation = relation;
        fastRelationCount++;
      });
      
      try {
        const fastStart = Date.now();
        blob.fastParse(emitter);
        const fastTime = Date.now() - fastStart;
        
        console.log(`   ⏱️  Fast parsing time: ${fastTime}ms`);
        console.log(`   📊 Fast results: ${fastNodeCount} nodes, ${fastWayCount} ways, ${fastRelationCount} relations`);
        
        // Compare with lazy parsing
        if (fastNodeCount !== nodeCount && nodeCount < 1000) {
          console.log(`   ⚠️  Node count mismatch: lazy=${nodeCount}, fast=${fastNodeCount}`);
        }
        if (fastWayCount !== wayCount && wayCount < 500) {
          console.log(`   ⚠️  Way count mismatch: lazy=${wayCount}, fast=${fastWayCount}`);
        }
        if (fastRelationCount !== relationCount && relationCount < 100) {
          console.log(`   ⚠️  Relation count mismatch: lazy=${relationCount}, fast=${fastRelationCount}`);
        }
        
        if (fastSampleNode && sampleNode) {
          const coordMatch = Math.abs(fastSampleNode.lat - sampleNode.lat) < 0.000001 && 
                           Math.abs(fastSampleNode.lon - sampleNode.lon) < 0.000001;
          console.log(`   🎯 Sample node coord match: ${coordMatch ? '✓' : '✗'}`);
        }
        
      } catch (e) {
        console.log(`   ⚡ Fast parser error: ${e.message}`);
      }
    }
    
    // 4. REFERENCE PARSER COMPARISON (if available)
    if (event.blobIndex <= 2) { // Only for first few blobs to avoid overwhelming output
      try {
        console.log(`\n📚 REFERENCE PARSER COMPARISON:`);
        
        // Try to get reference data for this specific blob using our reference parser
        const pbfParser = require('../lib/pbfParser.js');
        let referenceNodeCount = 0, referenceWayCount = 0, referenceRelationCount = 0;
        let referenceSampleNode = null, referenceSampleWay = null, referenceSampleRelation = null;
        
        // Create a mock options object to capture reference parser output
        const refParseOptions = {
          filePath: filePath,
          verbose: false,
          callback: () => {},
          error: () => {},
          endDocument: () => {},
          found: () => {},
          node: (node) => {
            if (referenceNodeCount === 0) referenceSampleNode = node;
            referenceNodeCount++;
          },
          way: (way) => {
            if (referenceWayCount === 0) referenceSampleWay = way;
            referenceWayCount++;
          },
          relation: (relation) => {
            if (referenceRelationCount === 0) referenceSampleRelation = relation;
            referenceRelationCount++;
          }
        };
        
        // This is just a quick comparison - in practice we'd need to run the reference parser separately
        console.log(`   📊 Reference comparison: Not implemented yet (would show protobuf-based parser results)`);
        console.log(`   🎯 Use 'node generate-pbf-reference.js' to see ground truth data`);
        
        // Show what we expect to compare
        if (nodeCount > 0 || wayCount > 0 || relationCount > 0) {
          console.log(`   🔍 Our custom parser found: ${nodeCount} nodes, ${wayCount} ways, ${relationCount} relations`);
          console.log(`   📝 To validate: Run reference parser and compare element counts and coordinates`);
          
          if (sampleNode) {
            console.log(`   📍 First node from custom parser: ID=${sampleNode.id}, coords=(${sampleNode.lat}, ${sampleNode.lon})`);
          }
          if (sampleWay) {
            console.log(`   🛣️  First way from custom parser: ID=${sampleWay.id}, ${sampleWay.refs.length} node refs`);
          }
          if (sampleRelation) {
            console.log(`   🔗 First relation from custom parser: ID=${sampleRelation.id}, ${sampleRelation.members.length} members`);
          }
        }
        
      } catch (refError) {
        console.log(`   ❌ Reference comparison error: ${refError.message}`);
      }
    }
    
    console.log(`\n💾 Blob ${event.blobIndex} buffer size: ${blob.buffer.length} bytes`);
    
    const blobProcessingEnd = process.hrtime.bigint();
    const totalBlobTime = blobProcessingEnd - blobProcessingStart;
    console.log(`⏱️  Total blob processing time: ${totalBlobTime}ns (${Number(totalBlobTime) / 1000000}ms)`);
  });
  
  parser.on('end', (event) => {
    console.log('\n' + '═'.repeat(80));
    console.log(`🏁 PARSING COMPLETE`);
    console.log(`⏱️  Total time: ${event.elapsed ? event.elapsed.toFixed(1) : 'N/A'} seconds`);
    console.log(`📦 Blobs processed: ${blobCount}`);
    console.log(`📊 Total elements found:`);
    console.log(`   📍 Nodes: ${totalNodes.toLocaleString()}`);
    console.log(`   🛣️  Ways: ${totalWays.toLocaleString()}`);
    console.log(`   🔗 Relations: ${totalRelations.toLocaleString()}`);
    console.log(`   📁 Total: ${(totalNodes + totalWays + totalRelations).toLocaleString()}`);
    console.log('═'.repeat(80));
  });
  
  parser.on('error', (err) => {
    console.error("❌ Error:", err.message);
    console.error(err.stack);
  });
  
  parser.parse();
}

// Optimized quick scan function using fast mode
function runOptimizedQuickScan(filePath, showDetailsForFirstBlobs = 3, read_threshold = null) {
  console.log('⚡ RUNNING OPTIMIZED QUICK SCAN');
  console.log('═'.repeat(80));
  
  const parser = new OSM_PBF_Parser_Decode(filePath, { 
    verbose: false, 
    highWaterMark: 8 * 1024 * 1024,
    fastMode: true,
    emitRawData: true,
    read_threshold: read_threshold
  });
  
  // Set global reference for cleanup
  if (typeof global !== 'undefined') global.currentParser = parser;
  
  let totalNodes = 0, totalWays = 0, totalRelations = 0;
  let blobCount = 0, osmDataBlobs = 0, osmHeaderBlobs = 0;
  let totalStringTableEntries = 0;
  let totalDecompressedBytes = 0;
  let totalProcessingTime = 0n;
  let lastProgressTime = 0; // For throttling progress output
  
  parser.on('start', (event) => {
    console.log(`📁 File: ${event.file_path}`);
    console.log(`📊 Size: ${(event.file_size / 1024 / 1024).toFixed(2)} MB (${event.file_size.toLocaleString()} bytes)`);
    console.log(`🚀 Mode: Optimized Fast Scan (24GB limit)`);
    console.log('─'.repeat(50));
  });
  
  parser.on('blob-ready', (event) => {
    // Stop processing blobs if parser has been stopped or threshold reached
    if (parser._stopped_manually || parser._threshold_reached) {
      return;
    }
    
    const fastCountStart = process.hrtime.bigint();
    
    blobCount++;
    const blob = event.blob;
    const blobType = event.blobType || 'unknown';
    
    if (blobType === 'OSMHeader') {
      osmHeaderBlobs++;
      if (showDetailsForFirstBlobs > 0 && blobCount <= showDetailsForFirstBlobs) {
        console.log(`📦 BLOB ${event.blobIndex} (${blobType}, ${blob.buffer.length} bytes)`);
      }
      return;
    }
    
    if (blobType === 'OSMData') {
      osmDataBlobs++;
      totalDecompressedBytes += blob.buffer.length;
      
      // Fast element counting using the optimized method
      const counts = blob.getElementCounts();
      totalNodes += counts.nodes;
      totalWays += counts.ways;
      totalRelations += counts.relations;
      
      // Fast string counting
      const stringCount = blob.getStringCount();
      totalStringTableEntries += stringCount;
      
      const fastCountTime = process.hrtime.bigint() - fastCountStart;
      
      if (showDetailsForFirstBlobs > 0 && blobCount <= showDetailsForFirstBlobs) {
        console.log(`📦 BLOB ${event.blobIndex} (${blobType}): ${counts.nodes} nodes, ${counts.ways} ways, ${counts.relations} relations, ${stringCount} strings`);
        console.log(`   ⏱️  Fast count time: ${Number(fastCountTime) / 1000000}ms`);
      }
      
      // Progress indicator every 100 blobs (skip if parser is stopped) - but throttle console output
      if (osmDataBlobs % 100 === 0 && blobCount > showDetailsForFirstBlobs && !parser._stopped_manually && !parser._threshold_reached) {
        const now = Date.now();
        if (now - lastProgressTime >= 1000) { // Only log every 1 second
          console.log(`📦 Processed ${osmDataBlobs} data blobs... (${formatNumber(totalNodes)} nodes, ${formatNumber(totalWays)} ways, ${formatNumber(totalRelations)} relations)`);
          lastProgressTime = now;
        }
      }
    }
  });
  
  parser.on('end', (event) => {
    console.log('\n' + '═'.repeat(80));
    console.log(`🏁 OPTIMIZED QUICK SCAN COMPLETE`);
    console.log(`⏱️  Total time: ${event.elapsed ? event.elapsed.toFixed(1) : 'N/A'} seconds`);
    console.log(`🔧 Blob processing time: ${Number(totalProcessingTime) / 1000000}ms`);
    console.log(`📦 Total blobs: ${blobCount} (${osmHeaderBlobs} headers + ${osmDataBlobs} data)`);
    console.log(`💾 Decompressed data: ${(totalDecompressedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`🔤 Total string table entries: ${formatNumber(totalStringTableEntries)}`);
    console.log(`📊 Total elements found:`);
    console.log(`   📍 Nodes: ${formatNumber(totalNodes)}`);
    console.log(`   🛣️  Ways: ${formatNumber(totalWays)}`);
    console.log(`   🔗 Relations: ${formatNumber(totalRelations)}`);
    console.log(`   📁 Total: ${formatNumber(totalNodes + totalWays + totalRelations)}`);
    
    if (event.elapsed) {
      const elementsPerSec = (totalNodes + totalWays + totalRelations) / event.elapsed;
      const mbPerSec = (totalDecompressedBytes / 1024 / 1024) / event.elapsed;
      console.log(`🚀 Performance: ${elementsPerSec.toFixed(0)} elements/sec, ${mbPerSec.toFixed(1)} MB/sec`);
      console.log(`⚡ Processing efficiency: ${(Number(totalProcessingTime) / 1000000 / 1000).toFixed(3)}s blob processing vs ${event.elapsed.toFixed(3)}s total`);
    }
    
    console.log('═'.repeat(80));
  });
  
  parser.on('error', (err) => {
    console.error("❌ Error:", err.message);
    console.error(err.stack);
  });
  
  parser.parse();
}

// Fast counting function for raw primitive groups - optimized
function countElementsInRawGroup(group) {
  const buffer = group.buffer;
  const bufferLength = buffer.length;
  let offset = 0;
  let nodes = 0, ways = 0, relations = 0;
  
  // Pre-cache buffer length check
  while (offset < bufferLength) {
    try {
      const keyInfo = readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (wireType === 2) { // length-delimited - most common case first
        const lenInfo = readVarint(buffer, offset);
        const dataLen = lenInfo.value;
        offset += lenInfo.bytesRead;
        
        if (fieldNumber === 2) { // DenseNodes
          const denseBuffer = buffer.slice(offset, offset + dataLen);
          nodes += countDenseNodes(denseBuffer);
        } else if (fieldNumber === 3) { // Ways
          ways++;
        } else if (fieldNumber === 4) { // Relations
          relations++;
        }
        offset += dataLen;
      } else {
        offset = skipField(buffer, offset, wireType);
      }
    } catch (e) {
      break;
    }
  }
  
  return { nodes, ways, relations };
}

// Fast counting of dense nodes from raw buffer - optimized
function countDenseNodes(buffer) {
  const bufferLength = buffer.length;
  let offset = 0;
  
  while (offset < bufferLength) {
    try {
      const keyInfo = readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) { // id array - most likely field
        const lenInfo = readVarint(buffer, offset);
        const arrayEnd = offset + lenInfo.bytesRead + lenInfo.value;
        offset += lenInfo.bytesRead;
        
        // Fast varint counting without parsing values
        let count = 0;
        while (offset < arrayEnd && offset < bufferLength) {
          while (offset < arrayEnd && (buffer[offset] & 0x80)) offset++;
          if (offset < arrayEnd) {
            offset++;
            count++;
          }
        }
        return count;
      } else {
        offset = skipField(buffer, offset, wireType);
      }
    } catch (e) {
      break;
    }
  }
  
  return 0;
}

// Fast counting of strings in raw string table - optimized
function countStringsInRawTable(stringTable) {
  const buffer = stringTable.buffer;
  const bufferLength = buffer.length;
  let offset = 0;
  let count = 0;
  
  while (offset < bufferLength) {
    try {
      const keyInfo = readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) { // string field
        count++;
        // Skip the string data efficiently
        const lenInfo = readVarint(buffer, offset);
        offset += lenInfo.bytesRead + lenInfo.value;
      } else {
        offset = skipField(buffer, offset, wireType);
      }
    } catch (e) {
      break;
    }
  }
  
  return count;
}

// Utility functions for fast parsing - optimized versions
function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  let byte;
  
  // Optimized loop with early bounds check
  while (offset < buffer.length) {
    byte = buffer[offset++];
    bytesRead++;
    value |= (byte & 0x7F) << shift;
    if (!(byte & 0x80)) return { value, bytesRead };
    shift += 7;
    if (shift >= 28) break; // Prevent excessive shift - most varints are small
  }
  
  if (offset >= buffer.length) {
    throw new Error("Buffer ended while reading varint");
  }
  return { value, bytesRead };
}

function skipField(buffer, offset, wireType) {
  switch (wireType) {
    case 0: // varint - optimized version
      while (offset < buffer.length && (buffer[offset] & 0x80)) offset++;
      return offset < buffer.length ? offset + 1 : offset;
    case 2: // length-delimited
      const lenInfo = readVarint(buffer, offset);
      return offset + lenInfo.bytesRead + lenInfo.value;
    case 1: // 64-bit
      return offset + 8;
    case 5: // 32-bit
      return offset + 4;
    default:
      throw new Error(`Unsupported wire type: ${wireType}`);
  }
}

function runQuickScan(filePath, showDetailsForFirstBlobs = 3, read_threshold = null) {
  console.log('⚡ RUNNING QUICK SCAN');
  console.log('═'.repeat(80));
  
  const parser = new OSM_PBF_Parser_Decode(filePath, { 
    verbose: false, 
    highWaterMark: 8 * 1024 * 1024,
    read_threshold: read_threshold
    // No maxBlobLimit - scan entire file (or until read_threshold)
  });
  
  // Set global reference for cleanup
  if (typeof global !== 'undefined') global.currentParser = parser;
  
  let totalNodes = 0, totalWays = 0, totalRelations = 0;
  let blobCount = 0, osmDataBlobs = 0, osmHeaderBlobs = 0;
  let totalStringTableEntries = 0;
  let totalDecompressedBytes = 0;
  let lastProgressTime = 0; // For throttling progress output in quick scan
  
  parser.on('start', (event) => {
    console.log(`📁 File: ${event.file_path}`);
    console.log(`📊 Size: ${(event.file_size / 1024 / 1024).toFixed(2)} MB (${event.file_size.toLocaleString()} bytes)`);
    console.log('─'.repeat(50));
  });
  
  parser.on('blob-ready', (event) => {
    // Stop processing blobs if parser has been stopped or threshold reached
    if (parser._stopped_manually || parser._threshold_reached) {
      return;
    }
    
    blobCount++;
    const blob = event.blob;
    const blobType = event.blobType || 'unknown';
    
    if (blobType === 'OSMHeader') {
      osmHeaderBlobs++;
      if (showDetailsForFirstBlobs > 0 && blobCount <= showDetailsForFirstBlobs) {
        console.log(`\n📦 BLOB ${event.blobIndex} ANALYSIS (Type: ${blobType})`);
        console.log('─'.repeat(50));
        console.log(`⏭️  Skipping non-OSMData blob (type: ${blobType})`);
        console.log(`💾 Blob ${event.blobIndex} buffer size: ${blob.buffer.length} bytes`);
      }
      return;
    }
    
    if (blobType === 'OSMData') {
      osmDataBlobs++;
      totalDecompressedBytes += blob.buffer.length;
      
      // Quick string table count
      const stringCount = blob.getStringCount();
      totalStringTableEntries += stringCount;
      
      // Show detailed analysis for first few blobs (both header and data blobs count toward the limit)
      if (showDetailsForFirstBlobs > 0 && blobCount <= showDetailsForFirstBlobs) {
        console.log(`\n📦 BLOB ${event.blobIndex} ANALYSIS (Type: ${blobType})`);
        console.log('─'.repeat(50));
        
        // Raw structure analysis for first few blobs
        console.log(`\n🔍 RAW STRUCTURE ANALYSIS:`);
        const analysis = blob.analyzeRawStructure();
        console.log(`   Total size: ${analysis.totalSize} bytes`);
        console.log(`   Fields found: ${analysis.fields.length}`);
        if (analysis.errors.length > 0) {
          console.log(`   Errors: ${analysis.errors.length}`);
          analysis.errors.slice(0, 3).forEach(err => console.log(`     - ${err}`));
        }
        
        // Show first few fields
        analysis.fields.slice(0, 6).forEach((field, i) => {
          const errorStr = field.error ? ` ERROR: ${field.error}` : '';
          console.log(`   [${i}] Field ${field.fieldNumber}, wire ${field.wireType}, offset ${field.offset}${errorStr}`);
        });
        
        // String table analysis
        console.log(`\n🔤 STRING TABLE ANALYSIS:`);
        console.log(`   📊 Found: ${stringCount} strings`);
        
        // Show sample strings for detailed blobs
        if (stringCount > 0) {
          console.log(`   Sample strings:`);
          for (let i = 0; i < Math.min(8, stringCount); i++) {
            try {
              const str = blob.getStringByIndex(i);
              const display = str.length > 25 ? str.substring(0, 25) + '...' : str;
              console.log(`   [${i}] "${display}"`);
            } catch (e) {
              console.log(`   [${i}] <error: ${e.message}>`);
            }
          }
        }
      }
      
      // Quick element counts (with limits for performance)
      let nodeCount = 0, wayCount = 0, relationCount = 0;
      let sampleNode = null, sampleWay = null, sampleRelation = null;
      
      try {
        for (const node of blob.iterateNodes()) {
          if (nodeCount === 0) sampleNode = node;
          nodeCount++;
          if (nodeCount >= 50000) break; // Reasonable limit
        }
        totalNodes += nodeCount;
      } catch (e) {
        console.log(`⚠️  Blob ${event.blobIndex}: Node parsing error - ${e.message}`);
      }
      
      try {
        for (const way of blob.iterateWays()) {
          if (wayCount === 0) sampleWay = way;
          wayCount++;
          if (wayCount >= 10000) break; // Reasonable limit
        }
        totalWays += wayCount;
      } catch (e) {
        console.log(`⚠️  Blob ${event.blobIndex}: Way parsing error - ${e.message}`);
      }
      
      try {
        for (const relation of blob.iterateRelations()) {
          if (relationCount === 0) sampleRelation = relation;
          relationCount++;
          if (relationCount >= 5000) break; // Reasonable limit
        }
        totalRelations += relationCount;
      } catch (e) {
        console.log(`⚠️  Blob ${event.blobIndex}: Relation parsing error - ${e.message}`);
      }
      
      // Show detailed parsing results for first few blobs
      if (showDetailsForFirstBlobs > 0 && blobCount <= showDetailsForFirstBlobs) {
        console.log(`\n🔍 PARSING RESULTS:`);
        console.log(`   📍 Nodes: ${nodeCount}${nodeCount >= 50000 ? '+' : ''}`);
        if (sampleNode) {
          console.log(`     Sample: ID=${sampleNode.id}, lat=${sampleNode.lat.toFixed(6)}, lon=${sampleNode.lon.toFixed(6)}`);
          const tagCount = Object.keys(sampleNode.tags).length;
          console.log(`     Tags: ${tagCount} (${Object.keys(sampleNode.tags).slice(0, 3).join(', ')}${tagCount > 3 ? '...' : ''})`);
        }
        
        console.log(`   🛣️  Ways: ${wayCount}${wayCount >= 10000 ? '+' : ''}`);
        if (sampleWay) {
          console.log(`     Sample: ID=${sampleWay.id}, refs=${sampleWay.refs.length} nodes`);
          const tagCount = Object.keys(sampleWay.tags).length;
          console.log(`     Tags: ${tagCount} (${Object.keys(sampleWay.tags).slice(0, 3).join(', ')}${tagCount > 3 ? '...' : ''})`);
        }
        
        console.log(`   🔗 Relations: ${relationCount}${relationCount >= 5000 ? '+' : ''}`);
        if (sampleRelation) {
          console.log(`     Sample: ID=${sampleRelation.id}, members=${sampleRelation.members.length}`);
          const tagCount = Object.keys(sampleRelation.tags).length;
          console.log(`     Tags: ${tagCount} (${Object.keys(sampleRelation.tags).slice(0, 3).join(', ')}${tagCount > 3 ? '...' : ''})`);
        }
        
        console.log(`\n💾 Blob ${event.blobIndex} buffer size: ${blob.buffer.length} bytes`);
      }
      
      // Progress indicator every 100 blobs (but skip if we're showing details for early blobs or parser is stopped)
      if (osmDataBlobs % 100 === 0 && blobCount > showDetailsForFirstBlobs && !parser._stopped_manually && !parser._threshold_reached) {
        const now = Date.now();
        if (now - lastProgressTime >= 1000) { // Throttle to once per second
          console.log(`📦 Processed ${osmDataBlobs} data blobs... (${formatNumber(totalNodes)} nodes, ${formatNumber(totalWays)} ways, ${formatNumber(totalRelations)} relations)`);
          lastProgressTime = now;
        }
      }
    }
  });
  
  parser.on('end', (event) => {
    console.log('\n' + '═'.repeat(80));
    console.log(`🏁 QUICK SCAN COMPLETE`);
    console.log(`⏱️  Total time: ${event.elapsed ? event.elapsed.toFixed(1) : 'N/A'} seconds`);
    console.log(`📦 Total blobs: ${blobCount} (${osmHeaderBlobs} headers + ${osmDataBlobs} data)`);
    console.log(`💾 Decompressed data: ${(totalDecompressedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`🔤 Total string table entries: ${formatNumber(totalStringTableEntries)}`);
    console.log(`📊 Total elements found:`);
    console.log(`   📍 Nodes: ${formatNumber(totalNodes)}${totalNodes >= 50000 * osmDataBlobs ? ' (truncated)' : ''}`);
    console.log(`   🛣️  Ways: ${formatNumber(totalWays)}${totalWays >= 10000 * osmDataBlobs ? ' (truncated)' : ''}`);
    console.log(`   🔗 Relations: ${formatNumber(totalRelations)}${totalRelations >= 5000 * osmDataBlobs ? ' (truncated)' : ''}`);
    console.log(`   📁 Total: ${formatNumber(totalNodes + totalWays + totalRelations)}`);
    
    if (event.elapsed) {
      const elementsPerSec = (totalNodes + totalWays + totalRelations) / event.elapsed;
      const mbPerSec = (totalDecompressedBytes / 1024 / 1024) / event.elapsed;
      console.log(`🚀 Performance: ${elementsPerSec.toFixed(0)} elements/sec, ${mbPerSec.toFixed(1)} MB/sec`);
    }
    
    console.log('═'.repeat(80));
  });
  
  parser.on('error', (err) => {
    console.error("❌ Error:", err.message);
    console.error(err.stack);
  });
  
  parser.parse();
}

// Driver code for standalone execution
if (require.main === module) {
  const filePath = process.argv[2] || "D:\\planet-250203.osm.pbf";
  const mode = process.argv[3] || "fast"; // "fast" is now default for best performance
  
  // Add signal handlers for manual interruption detection
  let interruptHandled = false;
  const handleInterrupt = (signal) => {
    if (interruptHandled) return;
    interruptHandled = true;
    console.log(`\n🛑 Received ${signal} signal - stopping decoder manually...`);
    
    // Cleanup current parser if it exists
    const currentParser = global.currentParser;
    if (currentParser) {
      console.log('🧹 Cleaning up parser resources...');
      if (typeof currentParser.stop === 'function') {
        currentParser.stop();
      }
      // If the parser has a decompression pool, shut it down
      if (currentParser.decompressionPool && typeof currentParser.decompressionPool.shutdown === 'function') {
        currentParser.decompressionPool.shutdown().catch(console.error);
      }
    }
    
    setTimeout(() => process.exit(0), 200);
  };
  
  // Multiple signal handlers for better Windows compatibility
  process.on('SIGINT', () => handleInterrupt('SIGINT'));
  process.on('SIGTERM', () => handleInterrupt('SIGTERM'));
  process.on('SIGBREAK', () => handleInterrupt('SIGBREAK')); // Windows specific
  
  // Also handle beforeExit to catch manual stops
  process.on('beforeExit', (code) => {
    if (code !== 0) {
      console.log('🛑 Decoder process exiting due to manual interruption');
      const currentParser = global.currentParser;
      if (currentParser && currentParser.decompressionPool && typeof currentParser.decompressionPool.shutdown === 'function') {
        currentParser.decompressionPool.shutdown().catch(console.error);
      }
    }
  });
  
  if (!filePath || filePath === "--help" || filePath === "-h") {
    console.log("OSM PBF Parser - Usage:");
    console.log("  node OSM_PBF_Parser_Decode.js <file.pbf> [mode] [options]");
    console.log("");
    console.log("Modes:");
    console.log("  fast (default)       - Optimized fast scan with 24GB read limit");
    console.log("  quick/scan           - Full file scan with details on first 3 blobs");
    console.log("  detailed             - Intensive debugging analysis (limited blobs)");
    console.log("");
    console.log("Options:");
    console.log("  For detailed mode: [maxBlobs] - Maximum number of blobs to analyze (default: 3)");
    console.log("  For quick mode: [detailBlobs] - Number of blobs to show details for (default: 3)");
    console.log("  For fast mode: [detailBlobs] - Number of blobs to show details for (default: 3)");
    console.log("");
    console.log("Examples:");
    console.log("  node OSM_PBF_Parser_Decode.js planet.pbf              # Fast scan with 24GB limit");
    console.log("  node OSM_PBF_Parser_Decode.js planet.pbf fast 5       # Fast scan with details for first 5 blobs");
    console.log("  node OSM_PBF_Parser_Decode.js planet.pbf quick 5      # Show details for first 5 blobs");
    console.log("  node OSM_PBF_Parser_Decode.js test.pbf detailed       # Full debug analysis");
    console.log("  node OSM_PBF_Parser_Decode.js test.pbf detailed 10    # Debug first 10 blobs");
    process.exit(0);
  }
  
  // Use default 24GB read threshold (can be overridden by constructor options)
  const read_threshold = 24 * 1024 * 1024 * 1024; // 24GB default
  
  if (mode === "detailed" || mode === "debug") {
    const maxBlobs = process.argv[4] !== undefined ? parseInt(process.argv[4]) : 3;
    console.log(`🔍 Running detailed analysis on ${filePath}${read_threshold ? ` (limited to ${formatThreshold(read_threshold)})` : ''}`);
    runDetailedAnalysis(filePath, maxBlobs, read_threshold);
  } else if (mode === "fast" || mode === "optimized") {
    const detailBlobs = process.argv[4] !== undefined ? parseInt(process.argv[4]) : 3;
    console.log(`⚡ Running optimized scan on ${filePath}${read_threshold ? ` (limited to ${formatThreshold(read_threshold)})` : ''}`);
    runOptimizedQuickScan(filePath, detailBlobs, read_threshold);
  } else {
    // Default to regular quick scan (quick/scan mode)
    const detailBlobs = process.argv[4] !== undefined ? parseInt(process.argv[4]) : 3;
    console.log(`⚡ Running quick scan on ${filePath}${read_threshold ? ` (limited to ${formatThreshold(read_threshold)})` : ''}`);
    runQuickScan(filePath, detailBlobs, read_threshold);
  }
}

// Helper function to format threshold display
function formatThreshold(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

// Optimized number formatting - much faster than toLocaleString()
function formatNumber(num) {
  if (num < 10000) return num.toString();
  if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
  if (num < 1000000000) return (num / 1000000).toFixed(1) + 'M';
  return (num / 1000000000).toFixed(1) + 'B';
}

// Fast, throttled progress logging
function logProgress(message, lastTime, throttleMs = 1000) {
  const now = Date.now();
  if (now - lastTime >= throttleMs) {
    console.log(message);
    return now;
  }
  return lastTime;
}
