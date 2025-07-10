/**
 * Parallel processing module for OSM PBF files
 * Uses worker threads to process data in parallel for multi-core systems
 * 
 * Note: This is an advanced feature and requires Node.js 12+ with worker_threads support
 */

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const path = require('path');
const fs = require('fs');

class ParallelOSMProcessor {
  constructor(options = {}) {
    if (!isMainThread) {
      throw new Error('Cannot instantiate ParallelOSMProcessor in a worker thread');
    }
    
    this.options = Object.assign({
      filePath: null,
      numWorkers: options.numWorkers || Math.max(1, os.cpus().length - 1),
      highWaterMark: 64 * 1024 * 4,
      callbacks: {
        node: null,
        way: null, 
        relation: null,
        error: err => console.error(err),
        progress: data => console.log(data)
      }
    }, options);
    
    if (!this.options.filePath) {
      throw new Error('No file path provided');
    }
    
    this.workers = [];
    this.fileSize = 0;
    this.isRunning = false;
    this.stats = {
      startTime: 0,
      nodesProcessed: 0,
      waysProcessed: 0,
      relationsProcessed: 0,
      bytesProcessed: 0,
      errors: []
    };
  }
  
  /**
   * Start parallel processing
   */
  async start() {
    if (this.isRunning) {
      throw new Error('Processing is already running');
    }
    
    this.isRunning = true;
    this.stats.startTime = Date.now();
    
    try {
      // Get file size for partitioning
      const stats = await fs.promises.stat(this.options.filePath);
      this.fileSize = stats.size;
      
      // Create workers and assign file segments
      const segmentSize = Math.floor(this.fileSize / this.options.numWorkers);
      
      console.log(`Starting parallel processing with ${this.options.numWorkers} workers`);
      console.log(`File size: ${(this.fileSize / (1024 * 1024)).toFixed(2)}MB`);
      console.log(`Segment size: ${(segmentSize / (1024 * 1024)).toFixed(2)}MB per worker`);
      
      for (let i = 0; i < this.options.numWorkers; i++) {
        const startOffset = i * segmentSize;
        const endOffset = (i === this.options.numWorkers - 1) ? this.fileSize : startOffset + segmentSize;
        
        this._createWorker(i, startOffset, endOffset);
      }
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
    
    // Return control methods
    return {
      stop: () => this.stop(),
      getStats: () => this.getStats()
    };
  }
  
  /**
   * Create a worker for a file segment
   */
  _createWorker(index, startOffset, endOffset) {
    const worker = new Worker(path.join(__dirname, 'parallel-worker.js'), {
      workerData: {
        id: index,
        filePath: this.options.filePath,
        startOffset,
        endOffset,
        highWaterMark: this.options.highWaterMark
      }
    });
    
    worker.on('message', message => {
      switch (message.type) {
        case 'node':
          this.stats.nodesProcessed++;
          if (this.options.callbacks.node) {
            this.options.callbacks.node(message.data);
          }
          break;
          
        case 'way':
          this.stats.waysProcessed++;
          if (this.options.callbacks.way) {
            this.options.callbacks.way(message.data);
          }
          break;
          
        case 'relation':
          this.stats.relationsProcessed++;
          if (this.options.callbacks.relation) {
            this.options.callbacks.relation(message.data);
          }
          break;
          
        case 'progress':
          this.stats.bytesProcessed += message.data.bytesProcessed || 0;
          if (this.options.callbacks.progress) {
            this.options.callbacks.progress({
              workerId: index,
              ...message.data,
              overallStats: this.getStats()
            });
          }
          break;
          
        case 'error':
          this.stats.errors.push({
            workerId: index,
            message: message.data.message,
            stack: message.data.stack,
            time: new Date().toISOString()
          });
          
          if (this.options.callbacks.error) {
            this.options.callbacks.error(new Error(`Worker ${index}: ${message.data.message}`));
          }
          break;
          
        case 'complete':
          console.log(`Worker ${index} completed processing`);
          break;
      }
    });
    
    worker.on('error', err => {
      this.stats.errors.push({
        workerId: index,
        message: err.message,
        stack: err.stack,
        time: new Date().toISOString()
      });
      
      if (this.options.callbacks.error) {
        this.options.callbacks.error(err);
      }
    });
    
    worker.on('exit', code => {
      console.log(`Worker ${index} exited with code ${code}`);
      
      // Remove from workers array
      const workerIndex = this.workers.findIndex(w => w.id === index);
      if (workerIndex !== -1) {
        this.workers.splice(workerIndex, 1);
      }
      
      // If all workers are done, mark as completed
      if (this.workers.length === 0) {
        this.isRunning = false;
        console.log('All workers finished');
      }
    });
    
    // Store worker
    this.workers.push({ id: index, worker });
    console.log(`Started worker ${index} for segment ${startOffset}-${endOffset}`);
  }
  
  /**
   * Stop all workers
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    console.log('Stopping all workers...');
    
    const terminations = this.workers.map(({ worker }) => {
      return new Promise(resolve => {
        worker.once('exit', resolve);
        worker.terminate();
      });
    });
    
    await Promise.all(terminations);
    this.workers = [];
    this.isRunning = false;
    
    console.log('All workers terminated');
  }
  
  /**
   * Get current processing stats
   */
  getStats() {
    const now = Date.now();
    const elapsed = (now - this.stats.startTime) / 1000;
    
    return {
        elapsed,
        nodesProcessed: this.stats.nodesProcessed,
        waysProcessed: this.stats.waysProcessed,
        relationsProcessed: this.stats.relationsProcessed,
        bytesProcessed: this.stats.bytesProcessed,
        nodesPerSecond: elapsed > 0 ? Math.round(this.stats.nodesProcessed / elapsed) : 0,
        waysPerSecond: elapsed > 0 ? Math.round(this.stats.waysProcessed / elapsed) : 0,
        relationsPerSecond: elapsed > 0 ? Math.round(this.stats.relationsProcessed / elapsed) : 0,
        mbProcessed: this.stats.bytesProcessed / (1024 * 1024),
        mbPerSecond: elapsed > 0 ? (this.stats.bytesProcessed / (1024 * 1024)) / elapsed : 0,
        percentComplete: this.fileSize > 0 ? (this.stats.bytesProcessed / this.fileSize) * 100 : 0,
        errorCount: this.stats.errors.length
    };
  }
}