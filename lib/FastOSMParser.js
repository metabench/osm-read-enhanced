const OSM_Blob = require('./OSM_Blob');
const { EventEmitter } = require('events');

/**
 * Fast OSM PBF Parser
 * 
 * A high-performance parser that uses the new fast event-driven parsing
 * in OSM_Blob to process PBF data quickly without building complex data structures.
 * 
 * This parser is designed for speed and minimal memory usage.
 */
class FastOSMParser extends EventEmitter {
  constructor() {
    super();
    this.stats = {
      nodesProcessed: 0,
      waysProcessed: 0,
      relationsProcessed: 0,
      blobsProcessed: 0,
      startTime: null,
      endTime: null
    };
  }
  
  // Parse a decompressed blob using the fast parser
  parseBlob(blobData, blobIndex) {
    try {
      const blob = new OSM_Blob({
        index: blobIndex,
        data: blobData
      });
      
      // Set up event handlers to count and forward events
      const blobEmitter = new EventEmitter();
      
      blobEmitter.on('node', (node) => {
        this.stats.nodesProcessed++;
        this.emit('node', node);
      });
      
      blobEmitter.on('way', (way) => {
        this.stats.waysProcessed++;
        this.emit('way', way);
      });
      
      blobEmitter.on('relation', (relation) => {
        this.stats.relationsProcessed++;
        this.emit('relation', relation);
      });
      
      // Use the fast parser
      blob.fastParse(blobEmitter);
      this.stats.blobsProcessed++;
      
    } catch (error) {
      this.emit('error', error);
    }
  }
  
  // Start parsing - record start time
  start() {
    this.stats.startTime = Date.now();
    this.emit('start');
  }
  
  // End parsing - record end time and emit final stats
  end() {
    this.stats.endTime = Date.now();
    const duration = this.stats.endTime - this.stats.startTime;
    
    const finalStats = {
      ...this.stats,
      duration: duration,
      nodesPerSecond: this.stats.nodesProcessed / (duration / 1000),
      waysPerSecond: this.stats.waysProcessed / (duration / 1000),
      relationsPerSecond: this.stats.relationsProcessed / (duration / 1000),
      totalElements: this.stats.nodesProcessed + this.stats.waysProcessed + this.stats.relationsProcessed,
      elementsPerSecond: (this.stats.nodesProcessed + this.stats.waysProcessed + this.stats.relationsProcessed) / (duration / 1000)
    };
    
    this.emit('end', finalStats);
  }
  
  // Get current stats
  getStats() {
    const currentTime = Date.now();
    const duration = this.stats.startTime ? (currentTime - this.stats.startTime) : 0;
    
    return {
      ...this.stats,
      duration: duration,
      nodesPerSecond: duration > 0 ? this.stats.nodesProcessed / (duration / 1000) : 0,
      waysPerSecond: duration > 0 ? this.stats.waysProcessed / (duration / 1000) : 0,
      relationsPerSecond: duration > 0 ? this.stats.relationsProcessed / (duration / 1000) : 0,
      totalElements: this.stats.nodesProcessed + this.stats.waysProcessed + this.stats.relationsProcessed,
      elementsPerSecond: duration > 0 ? (this.stats.nodesProcessed + this.stats.waysProcessed + this.stats.relationsProcessed) / (duration / 1000) : 0
    };
  }
}

module.exports = FastOSMParser;
