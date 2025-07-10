/**
 * Simpler worker pool for decompression tasks
 */
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const fs = require('fs');
const zlib = require('zlib');

class DecompressionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.verbose = options.verbose || false;
    
    // Use minimal configuration with sensible defaults
    this.options = {
      numWorkers: Math.min(2, options.numWorkers || Math.floor(os.cpus().length / 2)),
      workerScript: options.workerScript || path.join(__dirname, 'decompression-worker.js'),
      maxQueueSize: options.maxQueueSize || 20,
      taskTimeout: options.taskTimeout || 30000,
      retryOnError: options.retryOnError || false,
      ...options
    };
    
    console.log(`DecompressionPool: Using ${this.options.numWorkers} worker threads`);
    
    this.workers = [];
    this.availableWorkers = [];
    this.taskQueue = [];
    this.taskMap = new Map();
    this.nextTaskId = 1;
    this.isInitialized = false;
    this.isShutdown = false;
    
    this.stats = {
      tasksProcessed: 0,
      bytesDecompressed: 0,
      compressionRatio: 0
    };

    this.maxWorkers = options.maxWorkers || require('os').cpus().length;
    this.activeWorkers = 0;

    // Add monitoring interval to log worker stats every second
    this.monitorInterval = setInterval(() => {
      const stats = this.getStats();
      console.log(`DecompressionPool Stats: Workers: ${stats.numWorkers}, Busy: ${stats.busyWorkers}, Queued Tasks: ${stats.queuedTasks}, Processed: ${stats.tasksProcessed}, MB Decompressed: ${stats.mbDecompressed}`);
    }, 1000);
  }
  
  // Initialize the worker pool
  async initialize() {
    if (this.isInitialized) return;
    
    try {
      console.log('Initializing decompression pool...');
      
      // Create workers
      for (let i = 0; i < this.options.numWorkers; i++) {
        await this._createWorker();
      }
      
      this.isInitialized = true;
      console.log(`Successfully initialized ${this.workers.length} workers`);
    } catch (err) {
      console.error(`Worker pool initialization failed: ${err.message}`);
      throw err;
    }
  }
  
  // Create a worker
  async _createWorker() {
    try {
      const workerScriptPath = this.options.workerScript;
      const worker = new Worker(workerScriptPath);
      
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`Worker initialization timed out after 10s`));
        }, 10000);
        
        worker.on('message', (message) => {
          if (message.type === 'ready') {
            clearTimeout(timeoutId);
            
            // Add to worker pool
            const workerInfo = { worker, busy: false };
            this.workers.push(workerInfo);
            this.availableWorkers.push(workerInfo);
            
            resolve();
          } else if (message.type === 'error' && message.id === 'initialization') {
            clearTimeout(timeoutId);
            reject(new Error(`Worker initialization error: ${message.error.message}`));
          } else if (message.type === 'success' || message.type === 'error') {
            this._handleTaskCompletion(workerInfo, message);
          }
        });
        
        worker.on('error', (error) => {
          console.error(`Worker error: ${error.message}`);
          clearTimeout(timeoutId);
          reject(error);
        });
      });
    } catch (error) {
      console.error(`Failed to create worker: ${error.message}`);
      throw error;
    }
  }
  
  // Queue a decompression task
  decompressBlob(data, format = 'zlib') {
    return new Promise((resolve, reject) => {
      // If not initialized, do it synchronously
      if (!this.isInitialized) {
        this._decompressSynchronously(data, format)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      const taskId = this.nextTaskId++;
      const task = { id: taskId, data, format, resolve, reject };
      
      this.taskMap.set(taskId, task);
      this.taskQueue.push(task);
      
      // Process immediately if possible
      this._processQueue();
      
      // Set up task timeout
      setTimeout(() => {
        if (this.taskMap.has(taskId)) {
          // Process synchronously as fallback
          this.taskMap.delete(taskId);
          console.log(`Task ${taskId} timed out, processing synchronously`);
          this._decompressSynchronously(data, format)
            .then(resolve)
            .catch(reject);
        }
      }, this.options.taskTimeout);
    });
  }
  
  // Process the task queue
  _processQueue() {
    if (this.taskQueue.length === 0 || this.availableWorkers.length === 0) {
      return;
    }
    
    const task = this.taskQueue.shift();
    const workerInfo = this.availableWorkers.shift();
    workerInfo.busy = true;
    
    try {
      // Always make a copy to avoid memory leaks
      const { id, format } = task;
      const bufferCopy = Buffer.from(task.data);
      
      // Clear the reference to free memory sooner
      task.data = null;
      
      workerInfo.worker.postMessage({
        id,
        data: bufferCopy,
        format
      });
    } catch (err) {
      console.error(`Error sending task to worker: ${err.message}`);
      
      // Return worker to available pool
      workerInfo.busy = false;
      this.availableWorkers.push(workerInfo);
      
      // Fall back to synchronous processing
      this.taskMap.delete(task.id);
      this._decompressSynchronously(task.data, task.format)
        .then(task.resolve)
        .catch(task.reject);
    }
  }
  
  // Handle task completion
  _handleTaskCompletion(workerInfo, message) {
    workerInfo.busy = false;
    this.availableWorkers.push(workerInfo);
    
    const taskId = message.id;
    const task = this.taskMap.get(taskId);
    if (!task) {
      // Process next task and return
      this._processQueue();
      return;
    }
    
    this.taskMap.delete(taskId);
    this.stats.tasksProcessed++;
    
    if (message.type === 'success') {
      // Update stats
      this.stats.bytesDecompressed += message.length;
      
      try {
        // Make a clean copy of the result
        const resultBuffer = Buffer.from(message.decompressedData);
        
        task.resolve({
          decompressedData: resultBuffer,
          length: message.length
        });
      } catch (err) {
        task.reject(new Error(`Failed to process result: ${err.message}`));
      }
    } else {
      task.reject(new Error(message.error ? message.error.message : 'Unknown error'));
    }
    
    // Process next task
    setImmediate(() => this._processQueue());
  }
  
  // Synchronous decompression fallback
  _decompressSynchronously(data, format) {
    return new Promise((resolve, reject) => {
      if (!data) {
        return reject(new Error('No data provided for decompression'));
      }
      
      const decompressFunction = format === 'gzip' ? zlib.gunzip :
                                format === 'raw' ? zlib.inflateRaw :
                                zlib.inflate;
      
      decompressFunction(data, (err, result) => {
        if (err) {
          // Try alternate format on failure
          if (format === 'zlib') {
            zlib.inflateRaw(data, (err2, result2) => {
              if (err2) return reject(err);
              resolve({ decompressedData: result2, length: result2.length });
            });
          } else {
            return reject(err);
          }
        } else {
          resolve({ decompressedData: result, length: result.length });
        }
      });
    });
  }
  
  // Simple stats
  getStats() {
    return {
      numWorkers: this.workers.length,
      busyWorkers: this.workers.filter(w => w.busy).length,
      queuedTasks: this.taskQueue.length,
      tasksProcessed: this.stats.tasksProcessed,
      mbDecompressed: (this.stats.bytesDecompressed / (1024 * 1024)).toFixed(2)
    };
  }
  
  // Queue size accessor
  getQueueSize() {
    return this.taskQueue.length;
  }
  
  // Shutdown method
  async shutdown() {
    if (this.isShutdown) return;
    
    this.isShutdown = true;
    console.log('Shutting down decompression pool');
    
    // Process pending tasks synchronously
    for (const task of this.taskMap.values()) {
      try {
        if (task.data) {
          const result = await this._decompressSynchronously(task.data, task.format);
          task.resolve(result);
        } else {
          task.reject(new Error('Task data unavailable during shutdown'));
        }
      } catch (err) {
        task.reject(err);
      }
    }
    
    this.taskMap.clear();
    this.taskQueue = [];
    
    // Terminate workers
    await Promise.all(this.workers.map(({ worker }) => {
      return new Promise(resolve => {
        worker.terminate().then(resolve).catch(resolve);
      });
    }));
    
    this.workers = [];
    this.availableWorkers = [];
    clearInterval(this.monitorInterval);  // Clear the monitor interval
    console.log('Decompression pool shutdown complete');
  }

  runTask(task, callback) {
    // Ensure pool is initialized; if not, initialize synchronously
    if (!this.isInitialized) {
      this.initialize()
        .then(() => this._enqueueTask(task, callback))
        .catch(err => callback(err));
    } else {
      this._enqueueTask(task, callback);
    }
  }
  
  _enqueueTask(task, callback) {
    const taskId = this.nextTaskId++;
    const newTask = { id: taskId, data: task.data, input_chunk_index: task.input_chunk_index, event: task.event, callback };
    this.taskMap.set(taskId, newTask);
    this.taskQueue.push(newTask);
    this._processQueue();
  }
  
  // And update _processQueue to dispatch tasks to available workers:
  _processQueue() {
    if (!this.taskQueue.length || !this.availableWorkers.length) return;
    
    const task = this.taskQueue.shift();
    const workerInfo = this.availableWorkers.shift();
    workerInfo.busy = true;
    
    // Store task id in workerInfo so that we can correlate replies
    const currentTaskId = task.id;
    
    // Make a copy of the task data to avoid memory leaks
    const bufferCopy = Buffer.from(task.data);
    
    workerInfo.worker.postMessage({
      id: currentTaskId,
      data: bufferCopy,
      format: task.event && (task.event.likelyCompressed ? 'zlib' : 'raw')
    });
    
    // Bind worker message and error handling using one-time listeners.
    const messageHandler = (message) => {
      if (message.id === currentTaskId) {
        workerInfo.busy = false;
        this.availableWorkers.push(workerInfo);
        this.taskMap.delete(message.id);
        this.stats.tasksProcessed++;
        if (message.error) {
          task.callback(new Error(message.error));
        } else {
          task.callback(null, { result: message.result, input_chunk_index: task.input_chunk_index, globalOffset: task.event.globalOffset });
        }
        workerInfo.worker.removeListener('message', messageHandler);
        workerInfo.worker.removeListener('error', errorHandler);
        setImmediate(() => this._processQueue());
      }
    };
    const errorHandler = (err) => {
      workerInfo.busy = false;
      this.availableWorkers.push(workerInfo);
      this.taskMap.delete(currentTaskId);
      task.callback(err);
      workerInfo.worker.removeListener('message', messageHandler);
      workerInfo.worker.removeListener('error', errorHandler);
      setImmediate(() => this._processQueue());
    };
    workerInfo.worker.once('message', messageHandler);
    workerInfo.worker.once('error', errorHandler);
  }
}

module.exports = DecompressionPool;
