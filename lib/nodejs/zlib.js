var zlib = require('zlib');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');

// Configuration for decompression workers
const ENABLE_DECOMPRESSION_WORKERS = process.env.OSM_ENABLE_DECOMPRESSION_WORKERS === 'true' || false;

// Worker thread configuration - can be overridden
let DECOMPRESSION_WORKER_CONFIG = {
    enabled: ENABLE_DECOMPRESSION_WORKERS,
    maxWorkers: null, // Will be calculated based on system if not set
    minWorkers: null, // Will be calculated based on system if not set
    optimalWorkers: null, // Will be calculated based on system if not set
    scalingMode: 'conservative' // Options: 'conservative', 'aggressive', 'fixed'
};

console.log(`OSM PBF Parser: Decompression workers ${DECOMPRESSION_WORKER_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);

// Global worker pool instance (only used if multithreading is enabled)
let workerPool = null;
// Enhanced Worker Pool for parallel decompression with smart scaling
// NOTE: This class is only instantiated when ENABLE_DECOMPRESSION_WORKERS is true
class WorkerPool {
    constructor() {
        this.workers = [];
        this.availableWorkers = [];
        this.busyWorkers = new Set();
        this.taskQueue = [];
        this.priorityQueue = []; // High priority tasks (highly compressed, large blocks)
        
        // Dynamic worker pool sizing based on system resources
        const cpuCount = require('os').cpus().length;
        const totalMemory = require('os').totalmem();
        
        // Scale workers based on CPU and memory with increased limits
        const configuredMax = DECOMPRESSION_WORKER_CONFIG.maxWorkers;
        const configuredMin = DECOMPRESSION_WORKER_CONFIG.minWorkers;
        const configuredOptimal = DECOMPRESSION_WORKER_CONFIG.optimalWorkers;
        
        if (configuredMax !== null) {
            // Use configured maximum - always respect explicit configuration
            this.maxWorkers = configuredMax;
        } else {
            // Calculate based on system resources
            this.maxWorkers = Math.min(
                Math.max(cpuCount - 1, 2), // Leave one CPU for main thread, min 2 workers (reduced for tests)
                Math.floor(totalMemory / (256 * 1024 * 1024)), // 256MB per worker (reduced for more workers)
                this.isTestEnvironment ? 2 : 12 // Max 2 workers in tests, 12 in production
            );
        }
        
        if (configuredMin !== null) {
            // Use configured minimum - always respect explicit configuration
            this.minWorkers = configuredMin;
        } else {
            // Calculate based on system and test environment
            this.minWorkers = this.isTestEnvironment ? 1 : Math.min(2, this.maxWorkers); // 1 worker in tests, min 2 in production
        }
        
        if (configuredOptimal !== null) {
            // Use configured optimal - always respect explicit configuration
            this.optimalWorkers = configuredOptimal;
        } else {
            // Calculate based on system and test environment
            this.optimalWorkers = this.isTestEnvironment ? 1 : Math.min(4, this.maxWorkers); // 1 worker in tests, 4 in production
        }
        
        this.workerIdleTimeout = 15000; // 15 seconds (more aggressive cleanup)
        this.pendingCallbacks = new Map();
        this.requestIdCounter = 0;
        
        // Performance tracking
        this.stats = {
            tasksCompleted: 0,
            totalProcessingTime: 0,
            avgProcessingTime: 0,
            peakWorkerCount: 0,
            memoryPressure: 0
        };
        
        // Scaling behavior configuration
        this.scalingMode = DECOMPRESSION_WORKER_CONFIG.scalingMode || 'conservative';
        
        // Adaptive throttling
        this.lastMemoryCheck = 0;
        this.memoryCheckInterval = 1000; // Check memory every second
        this.highMemoryThreshold = 0.85; // 85% memory usage
        
        // Auto-shutdown for test environments
        this.isTestEnvironment = process.env.NODE_ENV === 'test' || 
                                 process.argv.some(arg => arg.includes('test')) ||
                                 (process.argv[1] && process.argv[1].includes('test'));
        this.lastActivityTime = Date.now();
        this.autoShutdownTimeout = this.isTestEnvironment ? 1000 : 30000; // 1s in tests, 30s normally
        
        // Initialize minimum workers (skip only for unonfigured test environments)
        if (!this.isTestEnvironment || configuredMin !== null) {
            this.initializeMinWorkers();
        }
        
        // Start memory monitoring
        this.startMemoryMonitoring();
        
        // Start auto-shutdown monitoring for tests
        if (this.isTestEnvironment) {
            this.startAutoShutdownMonitoring();
        }
    }
    
    startAutoShutdownMonitoring() {
        this.autoShutdownInterval = setInterval(() => {
            const timeSinceLastActivity = Date.now() - this.lastActivityTime;
            const isIdle = (this.busyWorkers.size === 0 && 
                           this.taskQueue.length === 0 && 
                           this.priorityQueue.length === 0 &&
                           this.pendingCallbacks.size === 0);
            
            // Only auto-shutdown if we've been idle for a while AND no workers are busy
            if (timeSinceLastActivity > this.autoShutdownTimeout && isIdle && this.workers.length > 0) {
                console.log('Auto-shutting down worker pool due to inactivity in test environment');
                this.shutdown();
                
                // Clear the global worker pool reference to allow process to exit
                if (workerPool === this) {
                    workerPool = null;
                }
            }
        }, 200); // Check every 200ms
    }
    
    updateLastActivity() {
        this.lastActivityTime = Date.now();
    }
    
    startMemoryMonitoring() {
        this.memoryMonitorInterval = setInterval(() => {
            this.checkMemoryPressure();
        }, this.memoryCheckInterval);
    }
    
    checkMemoryPressure() {
        const memUsage = process.memoryUsage();
        const totalMemory = require('os').totalmem();
        const memoryRatio = memUsage.heapUsed / totalMemory;
        
        this.stats.memoryPressure = memoryRatio;
        
        // Adaptive worker scaling based on memory pressure and scaling mode
        if (memoryRatio > this.highMemoryThreshold && this.workers.length > this.minWorkers) {
            // High memory pressure - reduce workers regardless of scaling mode
            this.scaleDownWorkers(1);
        } else if (this.scalingMode === 'aggressive' && memoryRatio < 0.6 && this.workers.length < this.optimalWorkers && this.taskQueue.length > 0) {
            // Aggressive mode: Low memory pressure with pending tasks - scale up
            this.scaleUpWorkers(1);
        }
        // Conservative mode: Only scale up when explicitly requested (e.g., in processQueue)
        // Fixed mode: Never auto-scale (only manual scaling)
    }
    
    scaleUpWorkers(count) {
        for (let i = 0; i < count && this.workers.length < this.maxWorkers; i++) {
            this.createWorker();
        }
    }
    
    scaleDownWorkers(count) {
        let removed = 0;
        for (let i = this.workers.length - 1; i >= 0 && removed < count && this.workers.length > this.minWorkers; i--) {
            const worker = this.workers[i];
            if (worker.isIdle && !this.busyWorkers.has(worker)) {
                this.removeWorker(worker);
                removed++;
            }
        }
    }
    
    initializeMinWorkers() {
        for (let i = 0; i < this.minWorkers; i++) {
            this.createWorker();
        }
    }
    
    createWorker() {
        try {
            const workerScript = `
                const { parentPort } = require('worker_threads');
                const zlib = require('zlib');
                
                // Enhanced worker with batch processing capability and brotli support
                parentPort.on('message', ({ id, compressedData, action, batch, compressionType }) => {
                    try {
                        if (action === 'decompress') {
                            const startTime = process.hrtime.bigint();
                            
                            // Choose decompression method based on compression type
                            const decompressFunc = compressionType === 'brotli' ? zlib.brotliDecompress : zlib.inflate;
                            
                            decompressFunc(compressedData, (err, result) => {
                                const endTime = process.hrtime.bigint();
                                const processingTime = Number(endTime - startTime) / 1000000; // Convert to milliseconds
                                
                                parentPort.postMessage({ 
                                    id, 
                                    err: err ? err.message : null, 
                                    result,
                                    processingTime,
                                    type: 'result'
                                });
                            });
                        } else if (action === 'decompress_batch') {
                            // Process multiple small blocks together
                            const results = [];
                            let completed = 0;
                            let hasError = false;
                            
                            batch.forEach((item, index) => {
                                const decompressFunc = item.compressionType === 'brotli' ? zlib.brotliDecompress : zlib.inflate;
                                
                                decompressFunc(item.data, (err, result) => {
                                    if (hasError) return;
                                    
                                    if (err) {
                                        hasError = true;
                                        parentPort.postMessage({ 
                                            id, 
                                            err: err.message, 
                                            type: 'result' 
                                        });
                                        return;
                                    }
                                    
                                    results[index] = result;
                                    completed++;
                                    
                                    if (completed === batch.length) {
                                        parentPort.postMessage({ 
                                            id, 
                                            results,
                                            type: 'batch_result'
                                        });
                                    }
                                });
                            });
                        } else if (action === 'ping') {
                            parentPort.postMessage({ type: 'pong', id });
                        }
                    } catch (error) {
                        parentPort.postMessage({ 
                            id, 
                            err: error.message, 
                            type: 'result' 
                        });
                    }
                });
                
                // Handle uncaught exceptions
                process.on('uncaughtException', (error) => {
                    console.error('Worker uncaught exception:', error);
                    process.exit(1);
                });
            `;
            
            const worker = new Worker(workerScript, { eval: true });
            const workerId = this.workers.length;
            
            worker.workerId = workerId;
            worker.lastUsed = Date.now();
            worker.isIdle = true;
            worker.tasksCompleted = 0;
            worker.totalProcessingTime = 0;
            
            worker.on('message', (message) => {
                this.handleWorkerMessage(worker, message);
            });
            
            worker.on('error', (err) => {
                console.warn(`Worker ${workerId} error:`, err);
                this.removeWorker(worker);
            });
            
            worker.on('exit', (code) => {
                if (code !== 0) {
                    console.warn(`Worker ${workerId} exited with code ${code}`);
                }
                this.removeWorker(worker);
            });
            
            this.workers.push(worker);
            this.availableWorkers.push(worker);
            this.stats.peakWorkerCount = Math.max(this.stats.peakWorkerCount, this.workers.length);
            
            // Set up idle timeout for non-minimum workers
            if (this.workers.length > this.minWorkers) {
                this.setupWorkerIdleTimeout(worker);
            }
            
            return worker;
        } catch (error) {
            console.error('Failed to create worker:', error);
            return null;
        }
    }
    
    setupWorkerIdleTimeout(worker) {
        worker.idleTimer = setTimeout(() => {
            if (worker.isIdle && this.workers.length > this.minWorkers) {
                this.removeWorker(worker);
            }
        }, this.workerIdleTimeout);
    }
    
    removeWorker(worker) {
        if (worker.idleTimer) {
            clearTimeout(worker.idleTimer);
        }
        
        const workerIndex = this.workers.indexOf(worker);
        if (workerIndex > -1) {
            this.workers.splice(workerIndex, 1);
        }
        
        const availableIndex = this.availableWorkers.indexOf(worker);
        if (availableIndex > -1) {
            this.availableWorkers.splice(availableIndex, 1);
        }
        
        this.busyWorkers.delete(worker);
        
        try {
            worker.terminate();
        } catch (e) {
            // Worker already terminated
        }
    }
    
    handleWorkerMessage(worker, message) {
        this.updateLastActivity(); // Track activity when workers complete tasks
        
        if (message.type === 'result') {
            const callback = this.pendingCallbacks.get(message.id);
            if (callback) {
                this.pendingCallbacks.delete(message.id);
                
                // Update performance stats
                if (message.processingTime) {
                    worker.tasksCompleted++;
                    worker.totalProcessingTime += message.processingTime;
                    this.stats.tasksCompleted++;
                    this.stats.totalProcessingTime += message.processingTime;
                    this.stats.avgProcessingTime = this.stats.totalProcessingTime / this.stats.tasksCompleted;
                }
                
                if (message.err) {
                    callback(new Error(message.err));
                } else {
                    callback(null, message.result);
                }
            }
            
            // Return worker to available pool
            this.busyWorkers.delete(worker);
            this.availableWorkers.push(worker);
            worker.isIdle = true;
            worker.lastUsed = Date.now();
            
            // Process next task in queue (priority first)
            this.processQueue();
        } else if (message.type === 'batch_result') {
            const callback = this.pendingCallbacks.get(message.id);
            if (callback) {
                this.pendingCallbacks.delete(message.id);
                callback(null, message.results);
            }
            
            // Return worker to available pool
            this.busyWorkers.delete(worker);
            this.availableWorkers.push(worker);
            worker.isIdle = true;
            worker.lastUsed = Date.now();
            
            // Process next task in queue
            this.processQueue();
        }
    }
    
    getAvailableWorker() {
        // Try to get an available worker
        if (this.availableWorkers.length > 0) {
            return this.availableWorkers.pop();
        }
        
        // Create new worker if under limit and not under memory pressure
        if (this.workers.length < this.maxWorkers && this.stats.memoryPressure < this.highMemoryThreshold) {
            const worker = this.createWorker();
            return worker; // May be null if creation failed
        }
        
        return null;
    }
    
    inflateBlob(blob, callback, priority = 'normal') {
        this.updateLastActivity(); // Track activity for auto-shutdown
        
        const requestId = ++this.requestIdCounter;
        this.pendingCallbacks.set(requestId, callback);
        
        // Determine compression type
        const compressionType = blob.brotliData ? 'brotli' : 'zlib';
        const compressedData = blob.brotliData || blob.zlibData;
        
        const task = {
            id: requestId,
            compressedData: compressedData,
            compressionType: compressionType,
            action: 'decompress',
            priority: priority,
            dataSize: compressedData ? compressedData.length : 0,
            rawSize: blob.rawSize || 0
        };
        
        const worker = this.getAvailableWorker();
        if (worker) {
            this.executeTask(worker, task);
        } else {
            // Queue the task based on priority
            if (priority === 'high') {
                this.priorityQueue.push(task);
            } else {
                this.taskQueue.push(task);
            }
        }
    }
    
    executeTask(worker, task) {
        worker.isIdle = false;
        this.busyWorkers.add(worker);
        
        if (worker.idleTimer) {
            clearTimeout(worker.idleTimer);
            worker.idleTimer = null;
        }
        
        worker.postMessage(task);
    }
    
    processQueue() {
        // Process priority queue first
        while (this.priorityQueue.length > 0 && this.availableWorkers.length > 0) {
            const task = this.priorityQueue.shift();
            const worker = this.availableWorkers.pop();
            this.executeTask(worker, task);
        }
        
        // Then process regular queue
        while (this.taskQueue.length > 0 && this.availableWorkers.length > 0) {
            const task = this.taskQueue.shift();
            const worker = this.availableWorkers.pop();
            this.executeTask(worker, task);
        }
        
        // Scale up workers based on scaling mode and queue backlog
        const totalQueued = this.priorityQueue.length + this.taskQueue.length;
        if (totalQueued > 0 && this.availableWorkers.length === 0 && this.workers.length < this.maxWorkers) {
            if (this.scalingMode === 'aggressive') {
                // Aggressive: Scale up quickly when there's any backlog
                this.scaleUpWorkers(Math.min(4, this.maxWorkers - this.workers.length));
            } else if (this.scalingMode === 'conservative') {
                // Conservative: Only scale up when there's significant backlog
                if (totalQueued >= 3) {
                    this.scaleUpWorkers(1);
                }
            }
            // Fixed mode: Never auto-scale
        }
        
        // Proactive scaling for aggressive mode
        if (this.scalingMode === 'aggressive' && this.workers.length < this.optimalWorkers && (totalQueued > 0 || this.busyWorkers.size > 0)) {
            this.scaleUpWorkers(Math.min(2, this.optimalWorkers - this.workers.length));
        }
    }
    
    getStats() {
        return {
            totalWorkers: this.workers.length,
            availableWorkers: this.availableWorkers.length,
            busyWorkers: this.busyWorkers.size,
            queuedTasks: this.taskQueue.length,
            priorityTasks: this.priorityQueue.length,
            pendingCallbacks: this.pendingCallbacks.size,
            tasksCompleted: this.stats.tasksCompleted,
            avgProcessingTime: Math.round(this.stats.avgProcessingTime * 100) / 100,
            peakWorkerCount: this.stats.peakWorkerCount,
            memoryPressure: Math.round(this.stats.memoryPressure * 10000) / 100, // As percentage
            workerEfficiency: this.calculateWorkerEfficiency(),
            scalingMode: this.scalingMode,
            maxWorkers: this.maxWorkers,
            optimalWorkers: this.optimalWorkers
        };
    }
    
    calculateWorkerEfficiency() {
        if (this.workers.length === 0) return 0;
        
        let totalEfficiency = 0;
        this.workers.forEach(worker => {
            const efficiency = worker.tasksCompleted > 0 ? 
                (worker.tasksCompleted / (worker.totalProcessingTime || 1)) * 1000 : 0; // Tasks per second
            totalEfficiency += efficiency;
        });
        
        return Math.round((totalEfficiency / this.workers.length) * 100) / 100;
    }
    
    shutdown() {
        // Clear memory monitoring interval
        if (this.memoryMonitorInterval) {
            clearInterval(this.memoryMonitorInterval);
            this.memoryMonitorInterval = null;
        }
        
        // Clear auto-shutdown interval
        if (this.autoShutdownInterval) {
            clearInterval(this.autoShutdownInterval);
            this.autoShutdownInterval = null;
        }
        
        this.workers.forEach(worker => {
            this.removeWorker(worker);
        });
        this.workers = [];
        this.availableWorkers = [];
        this.busyWorkers.clear();
        this.taskQueue = [];
        this.priorityQueue = [];
        this.pendingCallbacks.clear();
    }
}

function getWorkerPool() {
    if (!DECOMPRESSION_WORKER_CONFIG.enabled) {
        throw new Error('Worker pool requested but decompression workers are disabled');
    }
    
    if (!workerPool) {
        workerPool = new WorkerPool();
    }
    return workerPool;
}

function inflateBlob(blob, callback, useWorkerThreads = false, priority = 'normal'){
    // Simple path separation based on configuration and request
    if (!DECOMPRESSION_WORKER_CONFIG.enabled || !useWorkerThreads) {
        // SINGLE-THREADED PATH: Use main thread zlib directly
        if (blob.brotliData) {
            return zlib.brotliDecompress(blob.brotliData, callback);
        } else {
            return zlib.inflate(blob.zlibData, callback);
        }
    } else {
        // MULTI-THREADED PATH: Try to use worker pool, fallback to sync if all workers busy
        try {
            const pool = getWorkerPool();
            
            // Proactively scale up workers if we're under optimal and have capacity
            if (pool.workers.length < pool.optimalWorkers && pool.workers.length < pool.maxWorkers) {
                // Scale up more aggressively to reach optimal worker count
                const workersToAdd = Math.min(3, pool.optimalWorkers - pool.workers.length);
                pool.scaleUpWorkers(workersToAdd);
            }
            
            // Check if workers are available or can be created
            if (pool.availableWorkers.length > 0 || pool.workers.length < pool.maxWorkers) {
                // Use worker pool
                pool.inflateBlob(blob, callback, priority);
            } else {
                // All workers busy and at max capacity - fallback to synchronous decompression
                if (blob.brotliData) {
                    return zlib.brotliDecompress(blob.brotliData, callback);
                } else {
                    return zlib.inflate(blob.zlibData, callback);
                }
            }
        } catch (err) {
            // Worker pool error - fallback to synchronous decompression
            if (blob.brotliData) {
                return zlib.brotliDecompress(blob.brotliData, callback);
            } else {
                return zlib.inflate(blob.zlibData, callback);
            }
        }
    }
}

// Alternative: Stream-based decompression for memory efficiency
function inflateBlobStream(blob, callback) {
    const chunks = [];
    let inflateStream;
    
    if (blob.brotliData) {
        inflateStream = zlib.createBrotliDecompress();
        inflateStream.on('data', (chunk) => {
            chunks.push(chunk);
        });
        
        inflateStream.on('end', () => {
            callback(null, Buffer.concat(chunks));
        });
        
        inflateStream.on('error', callback);
        
        inflateStream.write(blob.brotliData);
        inflateStream.end();
    } else {
        inflateStream = zlib.createInflate();
        inflateStream.on('data', (chunk) => {
            chunks.push(chunk);
        });
        
        inflateStream.on('end', () => {
            callback(null, Buffer.concat(chunks));
        });
        
        inflateStream.on('error', callback);
        
        inflateStream.write(blob.zlibData);
        inflateStream.end();
    }
}

// Alternative: Synchronous decompression (faster for small blocks)
function inflateBlobSync(blob) {
    try {
        if (blob.brotliData) {
            return zlib.brotliDecompressSync(blob.brotliData);
        } else {
            return zlib.inflateSync(blob.zlibData);
        }
    } catch (err) {
        throw err;
    }
}

// Get worker pool statistics for monitoring
function getWorkerPoolStats() {
    if (!DECOMPRESSION_WORKER_CONFIG.enabled) {
        // SINGLE-THREADED PATH: Return minimal stats
        return {
            totalWorkers: 0,
            availableWorkers: 0,
            busyWorkers: 0,
            queuedTasks: 0,
            priorityTasks: 0,
            pendingCallbacks: 0,
            tasksCompleted: 0,
            avgProcessingTime: 0,
            peakWorkerCount: 0,
            memoryPressure: 0,
            workerEfficiency: 0,
            decompressionWorkersEnabled: false
        };
    } else {
        // MULTI-THREADED PATH: Get actual worker pool stats
        try {
            const pool = getWorkerPool();
            const stats = pool.getStats();
            stats.decompressionWorkersEnabled = true;
            return stats;
        } catch (err) {
            // Fallback stats if worker pool fails
            return {
                totalWorkers: 0,
                availableWorkers: 0,
                busyWorkers: 0,
                queuedTasks: 0,
                priorityTasks: 0,
                pendingCallbacks: 0,
                tasksCompleted: 0,
                avgProcessingTime: 0,
                peakWorkerCount: 0,
                memoryPressure: 0,
                workerEfficiency: 0,
                decompressionWorkersEnabled: false
            };
        }
    }
}

// Shutdown worker pool (for cleanup)
function shutdownWorkerPool() {
    if (!DECOMPRESSION_WORKER_CONFIG.enabled) {
        // SINGLE-THREADED PATH: Nothing to shutdown
        return;
    } else {
        // MULTI-THREADED PATH: Shutdown worker pool
        if (workerPool) {
            workerPool.shutdown();
            workerPool = null; // Clear reference to allow process to exit
        }
    }
}

// Configure decompression workers
function configureDecompressionWorkers(config) {
    // Update the configuration
    if (config.enabled !== undefined) {
        DECOMPRESSION_WORKER_CONFIG.enabled = config.enabled;
    }
    if (config.maxWorkers !== undefined) {
        DECOMPRESSION_WORKER_CONFIG.maxWorkers = config.maxWorkers;
    }
    if (config.minWorkers !== undefined) {
        DECOMPRESSION_WORKER_CONFIG.minWorkers = config.minWorkers;
    }
    if (config.optimalWorkers !== undefined) {
        DECOMPRESSION_WORKER_CONFIG.optimalWorkers = config.optimalWorkers;
    }
    if (config.scalingMode !== undefined) {
        DECOMPRESSION_WORKER_CONFIG.scalingMode = config.scalingMode;
    }
    
    // If workers are already running, shut them down so they can be recreated with new config
    if (workerPool) {
        workerPool.shutdown();
        workerPool = null;
    }
    
    console.log(`OSM PBF Parser: Decompression workers ${DECOMPRESSION_WORKER_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);
    if (DECOMPRESSION_WORKER_CONFIG.enabled && DECOMPRESSION_WORKER_CONFIG.maxWorkers) {
        console.log(`  Max workers: ${DECOMPRESSION_WORKER_CONFIG.maxWorkers}`);
        console.log(`  Scaling mode: ${DECOMPRESSION_WORKER_CONFIG.scalingMode}`);
    }
}

module.exports = {
    inflateBlob: inflateBlob,
    inflateBlobStream: inflateBlobStream,
    inflateBlobSync: inflateBlobSync,
    getWorkerPoolStats: getWorkerPoolStats,
    shutdownWorkerPool: shutdownWorkerPool,
    configureDecompressionWorkers: configureDecompressionWorkers
};
