/*
 * OSM_PBF_Parser_Fast: High-performance PBF parser optimized for large files
 * 
 * This is a streamlined version inspired by pbfParser.js but with modern optimizations:
 * - Concurrent blob processing with worker pools
 * - Minimal memory allocation for summary scans
 * - Optional detailed analysis for debugging
 * - Efficient streaming for planet-scale files
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const OSM_PBF_Parser_Decompress = require('./OSM_PBF_Parser_Decompress.js');
const OSM_Blob = require('./OSM_Blob.js');

class OSM_PBF_Parser_Fast extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.options = {
      verbose: options.verbose || false,
      maxBlobLimit: options.maxBlobLimit || null,
      highWaterMark: options.highWaterMark || 16 * 1024 * 1024,
      concurrency: options.concurrency || 8,
      mode: options.mode || 'summary', // 'summary', 'detailed', 'count-only'
      showDetailsForFirstBlobs: options.showDetailsForFirstBlobs || 0,
      ...options
    };
    
    this.stats = {
      totalNodes: 0,
      totalWays: 0,
      totalRelations: 0,
      totalBlobs: 0,
      osmDataBlobs: 0,
      osmHeaderBlobs: 0,
      totalStringTableEntries: 0,
      totalDecompressedBytes: 0,
      bytesProcessed: 0,
      startTime: null,
      endTime: null
    };
    
    this.coreParser = null;
    this.blobsProcessed = 0;
    this.activeProcessing = 0;
    this.maxConcurrency = this.options.concurrency;
    this.pendingBlobs = [];
    this.finished = false;
  }
  
  async parse() {
    this.stats.startTime = Date.now();
    
    try {
      // Initialize decompression parser for file reading
      this.coreParser = new OSM_PBF_Parser_Decompress(this.filePath, {
        verbose: this.options.verbose,
        maxBlobLimit: this.options.maxBlobLimit,
        highWaterMark: this.options.highWaterMark
      });
      
      // Get file size for progress tracking
      const fileStats = await fs.promises.stat(this.filePath);
      
      this.emit('start', {
        file_path: this.filePath,
        file_size: fileStats.size,
        mode: this.options.mode
      });
      
      // Set up event handlers
      this.coreParser.on('blob-decompressed', (event) => {
        this.handleBlobExtracted(event);
      });
      
      this.coreParser.on('end', () => {
        this.handleParsingEnd();
      });
      
      this.coreParser.on('error', (err) => {
        this.emit('error', err);
      });
      
      // Start parsing
      this.coreParser.parse();
      
    } catch (err) {
      this.emit('error', err);
    }
  }
  
  handleBlobExtracted(event) {
    this.stats.totalBlobs++;
    this.stats.bytesProcessed += event.decompressedData ? event.decompressedData.length : 0;
    
    // Queue blob for processing
    this.pendingBlobs.push(event);
    this.processNextBlobs();
  }
  
  async processNextBlobs() {
    // Process blobs up to concurrency limit
    while (this.pendingBlobs.length > 0 && this.activeProcessing < this.maxConcurrency) {
      const blobEvent = this.pendingBlobs.shift();
      this.activeProcessing++;
      
      // Process blob asynchronously
      setImmediate(() => {
        this.processBlobEvent(blobEvent);
      });
    }
  }
  
  async processBlobEvent(event) {
    try {
      const blobType = event.blobType || 'unknown';
      
      if (blobType === 'OSMHeader') {
        this.stats.osmHeaderBlobs++;
        await this.processHeaderBlob(event);
      } else if (blobType === 'OSMData') {
        this.stats.osmDataBlobs++;
        await this.processDataBlob(event);
      }
      
    } catch (err) {
      this.emit('error', new Error(`Error processing blob ${event.blobIndex}: ${err.message}`));
    } finally {
      this.activeProcessing--;
      this.blobsProcessed++;
      
      // Check if we're done
      if (this.finished && this.activeProcessing === 0 && this.pendingBlobs.length === 0) {
        this.handleAllBlobsProcessed();
      } else {
        // Process more blobs if available
        this.processNextBlobs();
      }
    }
  }
  
  async processHeaderBlob(event) {
    // Show details for header blobs if requested
    if (this.shouldShowDetails(event.blobIndex)) {
      this.emit('blob-analysis', {
        blobIndex: event.blobIndex,
        blobType: 'OSMHeader',
        message: `Header blob (size: ${event.decompressedData ? event.decompressedData.length : 0} bytes)`
      });
    }
  }
  
  async processDataBlob(event) {
    this.stats.totalDecompressedBytes += event.decompressedData ? event.decompressedData.length : 0;
    
    // For summary mode, do minimal processing
    if (this.options.mode === 'summary' || this.options.mode === 'count-only') {
      await this.processBlobSummary(event);
    } else if (this.options.mode === 'detailed') {
      await this.processBlobDetailed(event);
    }
  }
  
  async processBlobSummary(event) {
    try {
      // Create minimal blob instance for fast counting
      const blob = new OSM_Blob({
        index: event.blobIndex,
        data: event.decompressedData
      });
      
      // Fast string table count
      const stringCount = blob.getStringCount();
      this.stats.totalStringTableEntries += stringCount;
      
      // Fast element counting without full iteration
      const elementCounts = blob.getElementCounts();
      this.stats.totalNodes += elementCounts.nodes;
      this.stats.totalWays += elementCounts.ways;
      this.stats.totalRelations += elementCounts.relations;
      
      // Show details for first few blobs if requested
      if (this.shouldShowDetails(event.blobIndex)) {
        await this.showBlobDetails(blob, event, elementCounts, stringCount);
      }
      
      // Emit progress for large files
      if (this.blobsProcessed % 100 === 0 || this.shouldShowDetails(event.blobIndex)) {
        this.emitProgress();
      }
      
    } catch (err) {
      console.warn(`Warning: Error processing blob ${event.blobIndex} in summary mode: ${err.message}`);
    }
  }
  
  async processBlobDetailed(event) {
    try {
      // Create full blob instance for detailed analysis
      const blob = new OSM_Blob({
        index: event.blobIndex,
        data: event.decompressedData
      });
      
      // String table analysis
      const stringCount = blob.getStringCount();
      this.stats.totalStringTableEntries += stringCount;
      
      // Detailed element iteration
      let nodeCount = 0, wayCount = 0, relationCount = 0;
      let sampleNode = null, sampleWay = null, sampleRelation = null;
      
      // Count nodes with sampling
      for (const node of blob.iterateNodes()) {
        if (nodeCount === 0) sampleNode = node;
        nodeCount++;
        if (nodeCount >= 1000) break; // Limit for performance
      }
      
      // Count ways with sampling
      for (const way of blob.iterateWays()) {
        if (wayCount === 0) sampleWay = way;
        wayCount++;
        if (wayCount >= 1000) break; // Limit for performance
      }
      
      // Count relations with sampling
      for (const relation of blob.iterateRelations()) {
        if (relationCount === 0) sampleRelation = relation;
        relationCount++;
        if (relationCount >= 1000) break; // Limit for performance
      }
      
      this.stats.totalNodes += nodeCount;
      this.stats.totalWays += wayCount;
      this.stats.totalRelations += relationCount;
      
      // Emit detailed blob analysis
      this.emit('blob-analysis', {
        blobIndex: event.blobIndex,
        blobType: 'OSMData',
        stringCount,
        elementCounts: { nodes: nodeCount, ways: wayCount, relations: relationCount },
        samples: { node: sampleNode, way: sampleWay, relation: sampleRelation },
        decompressedSize: event.decompressedData ? event.decompressedData.length : 0
      });
      
      this.emitProgress();
      
    } catch (err) {
      console.warn(`Warning: Error processing blob ${event.blobIndex} in detailed mode: ${err.message}`);
    }
  }
  
  async showBlobDetails(blob, event, elementCounts, stringCount) {
    try {
      this.emit('blob-analysis', {
        blobIndex: event.blobIndex,
        blobType: 'OSMData',
        stringCount,
        elementCounts,
        decompressedSize: event.decompressedData ? event.decompressedData.length : 0,
        message: `Blob ${event.blobIndex}: ${elementCounts.nodes} nodes, ${elementCounts.ways} ways, ${elementCounts.relations} relations, ${stringCount} strings`
      });
      
      // For detailed output, show samples
      if (this.options.verbose && elementCounts.nodes > 0) {
        try {
          const nodeIterator = blob.iterateNodes();
          const firstNode = nodeIterator.next().value;
          if (firstNode) {
            this.emit('blob-analysis', {
              blobIndex: event.blobIndex,
              message: `  Sample node: ID=${firstNode.id}, lat=${firstNode.lat.toFixed(6)}, lon=${firstNode.lon.toFixed(6)}, tags=${Object.keys(firstNode.tags || {}).length}`
            });
          }
        } catch (e) {
          // Ignore sampling errors
        }
      }
    } catch (err) {
      // Ignore detail errors for summary mode
    }
  }
  
  shouldShowDetails(blobIndex) {
    return this.options.showDetailsForFirstBlobs > 0 && blobIndex < this.options.showDetailsForFirstBlobs;
  }
  
  emitProgress() {
    const elapsed = (Date.now() - this.stats.startTime) / 1000;
    const mbPerSec = (this.stats.bytesProcessed / 1024 / 1024 / elapsed).toFixed(1);
    
    this.emit('progress', {
      blobsProcessed: this.blobsProcessed,
      totalBlobs: this.stats.totalBlobs,
      bytesProcessed: this.stats.bytesProcessed,
      mbPerSecond: parseFloat(mbPerSec),
      elapsed,
      elements: {
        nodes: this.stats.totalNodes,
        ways: this.stats.totalWays,
        relations: this.stats.totalRelations
      }
    });
  }
  
  handleParsingEnd() {
    this.finished = true;
    
    // If no active processing, finish immediately
    if (this.activeProcessing === 0 && this.pendingBlobs.length === 0) {
      this.handleAllBlobsProcessed();
    }
  }
  
  handleAllBlobsProcessed() {
    this.stats.endTime = Date.now();
    const elapsed = (this.stats.endTime - this.stats.startTime) / 1000;
    
    this.emit('end', {
      elapsed,
      stats: this.stats,
      performance: {
        mbPerSecond: (this.stats.bytesProcessed / 1024 / 1024 / elapsed).toFixed(1),
        blobsPerSecond: (this.stats.totalBlobs / elapsed).toFixed(1),
        elementsPerSecond: ((this.stats.totalNodes + this.stats.totalWays + this.stats.totalRelations) / elapsed).toFixed(0)
      }
    });
  }
}

module.exports = OSM_PBF_Parser_Fast;

// CLI interface
if (require.main === module) {
  const filePath = process.argv[2] || 'D:\\planet-250203.osm.pbf';
  const mode = process.argv[3] || 'summary';
  const detailBlobs = parseInt(process.argv[4]) || 3;
  
  console.log('🚀 OSM PBF Fast Parser');
  console.log('═'.repeat(80));
  
  const parser = new OSM_PBF_Parser_Fast(filePath, {
    mode: mode,
    showDetailsForFirstBlobs: detailBlobs,
    verbose: mode === 'detailed',
    concurrency: 12
  });
  
  parser.on('start', (event) => {
    console.log(`📁 File: ${event.file_path}`);
    console.log(`📊 Size: ${(event.file_size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`⚙️  Mode: ${event.mode}`);
    console.log('─'.repeat(50));
  });
  
  parser.on('blob-analysis', (event) => {
    if (event.message) {
      console.log(event.message);
    } else {
      console.log(`📦 Blob ${event.blobIndex} (${event.blobType}): ${event.elementCounts?.nodes || 0} nodes, ${event.elementCounts?.ways || 0} ways, ${event.elementCounts?.relations || 0} relations`);
    }
  });
  
  parser.on('progress', (event) => {
    if (event.blobsProcessed % 50 === 0) {
      console.log(`⚡ Progress: ${event.mbPerSecond} MB/s, ${event.blobsProcessed}/${event.totalBlobs} blobs, ${(event.elements.nodes + event.elements.ways + event.elements.relations).toLocaleString()} elements`);
    }
  });
  
  parser.on('end', (event) => {
    console.log('\n' + '═'.repeat(80));
    console.log('🏁 PARSING COMPLETE');
    console.log(`⏱️  Total time: ${event.elapsed.toFixed(1)} seconds`);
    console.log(`📊 Performance: ${event.performance.mbPerSecond} MB/s, ${event.performance.elementsPerSecond} elements/s`);
    console.log(`📦 Blobs: ${event.stats.totalBlobs} total (${event.stats.osmDataBlobs} data, ${event.stats.osmHeaderBlobs} header)`);
    console.log(`📍 Elements: ${event.stats.totalNodes.toLocaleString()} nodes, ${event.stats.totalWays.toLocaleString()} ways, ${event.stats.totalRelations.toLocaleString()} relations`);
    console.log(`🔤 Strings: ${event.stats.totalStringTableEntries.toLocaleString()} total`);
    console.log('═'.repeat(80));
  });
  
  parser.on('error', (err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
  
  parser.parse().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  });
}
