/**
 * Process OSM PBF data as a stream to minimize memory usage
 */
const { Transform } = require('stream');
const zlib = require('zlib');

class OSMStreamProcessor extends Transform {
  constructor(options = {}) {
    super({ 
      objectMode: true,
      highWaterMark: options.highWaterMark || 2 // Process only a few objects at a time
    });
    
    this.options = {
      processNodesInBatches: options.processNodesInBatches !== false,
      batchSize: options.batchSize || 1000,
      callbacks: options.callbacks || {},
      ...options
    };
    
    this.stats = {
      nodesProcessed: 0,
      waysProcessed: 0,
      relationsProcessed: 0,
      batchesProcessed: 0
    };
  }
  
  _transform(data, encoding, callback) {
    if (data.type === 'OSMData') {
      try {
        // Process data immediately and release memory
        const entities = this._extractEntities(data);
        
        // Process in smaller batches to reduce peak memory
        if (this.options.processNodesInBatches && entities.nodes.length > 0) {
          this._processBatches(entities.nodes, 'node', this.options.batchSize);
        } else if (entities.nodes.length > 0 && this.options.callbacks.node) {
          entities.nodes.forEach(node => this.options.callbacks.node(node));
        }
        
        // Ways and relations are typically smaller so process directly
        if (entities.ways.length > 0 && this.options.callbacks.way) {
          entities.ways.forEach(way => this.options.callbacks.way(way));
        }
        
        if (entities.relations.length > 0 && this.options.callbacks.relation) {
          entities.relations.forEach(relation => this.options.callbacks.relation(relation));
        }
        
        // Update stats
        this.stats.nodesProcessed += entities.nodes.length;
        this.stats.waysProcessed += entities.ways.length;
        this.stats.relationsProcessed += entities.relations.length;
        
        // Force cleanup of entity data
        entities.nodes = null;
        entities.ways = null;
        entities.relations = null;
        
        // Optional: force garbage collection
        if (global.gc && this.stats.nodesProcessed % 1000000 === 0) {
          global.gc();
        }
      } catch (err) {
        return callback(err);
      }
    }
    
    // Pass the data through
    this.push(data);
    callback();
  }
  
  _processBatches(items, type, batchSize) {
    const callback = this.options.callbacks[type];
    if (!callback) return;
    
    // Process in batches to avoid memory spikes
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      batch.forEach(item => callback(item));
      this.stats.batchesProcessed++;
    }
  }
  
  _extractEntities(osmData) {
    // Your entity extraction logic here
    // ...
    
    // Return placeholder for now
    return {
      nodes: [],
      ways: [],
      relations: []
    };
  }
  
  getStats() {
    return { ...this.stats };
  }
}

module.exports = OSMStreamProcessor;
