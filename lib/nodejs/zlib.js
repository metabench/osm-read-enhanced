var zlib = require('zlib');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

// Configuration
const ENABLE_MULTITHREADING = false; // Disabled for simpler single-threaded operation

console.log(`OSM PBF Parser: Multithreading ${ENABLE_MULTITHREADING ? 'ENABLED' : 'DISABLED'}`);

// Global worker pool instance (only used if multithreading is enabled)
let workerPool = null;
// Enhanced Worker Pool for parallel decompression with smart scaling
// NOTE: This class is only instantiated when ENABLE_MULTITHREADING is true
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
        this.maxWorkers = Math.min(
            Math.max(cpuCount - 1, 4), // Leave one CPU for main thread, min 4 workers
            Math.floor(totalMemory / (256 * 1024 * 1024)), // 256MB per worker (reduced for more workers)
            12 // Increased hard cap from 8 to 12 for better performance
        );
        this.minWorkers = Math.min(4, this.maxWorkers); // Increased min workers from 2 to 4
        this.optimalWorkers = Math.min(8, this.maxWorkers); // Increased optimal from 4 to 8
        
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
        
        // Adaptive throttling
        this.lastMemoryCheck = 0;
        this.memoryCheckInterval = 1000; // Check memory every second
        this.highMemoryThreshold = 0.85; // 85% memory usage
        
        // Auto-shutdown for test environments
        this.isTestEnvironment = process.env.NODE_ENV === 'test' || 
                                 process.argv.some(arg => arg.includes('test')) ||
                                 process.argv[1] && process.argv[1].includes('test');
        this.lastActivityTime = Date.now();
        this.autoShutdownTimeout = this.isTestEnvironment ? 2500 : 30000; // 2.5s in tests, 30s normally
        
        // Initialize minimum workers
        this.initializeMinWorkers();
        
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
                
                // For tests, set a fallback exit timer to prevent hanging
                if (this.isTestEnvironment) {
                    setTimeout(() => {
                        // Only force exit if no other activity is happening
                        if (this.workers.length === 0) {
                            console.log('Force exiting due to test completion');
                            process.exit(0);
                        }
                    }, 1000);
                }
            }
        }, 500); // Check every 500ms
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
        
        // Adaptive worker scaling based on memory pressure
        if (memoryRatio > this.highMemoryThreshold && this.workers.length > this.minWorkers) {
            // High memory pressure - reduce workers
            this.scaleDownWorkers(1);
        } else if (memoryRatio < 0.6 && this.workers.length < this.optimalWorkers && this.taskQueue.length > 0) {
            // Low memory pressure with pending tasks - scale up
            this.scaleUpWorkers(1);
        }
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
        const workerScript = `
            const { parentPort } = require('worker_threads');
            const zlib = require('zlib');
            
            // Enhanced worker with batch processing capability
            parentPort.on('message', ({ id, zlibData, action, batch }) => {
                if (action === 'decompress') {
                    const startTime = process.hrtime.bigint();
                    
                    zlib.inflate(zlibData, (err, result) => {
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
                        zlib.inflate(item.data, (err, result) => {
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
            return this.createWorker();
        }
        
        return null;
    }
    
    inflateBlob(blob, callback, priority = 'normal') {
        this.updateLastActivity(); // Track activity for auto-shutdown
        
        const requestId = ++this.requestIdCounter;
        this.pendingCallbacks.set(requestId, callback);
        
        const task = {
            id: requestId,
            zlibData: blob.zlibData,
            action: 'decompress',
            priority: priority,
            dataSize: blob.zlibData ? blob.zlibData.length : 0,
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
        
        // If we still have queued tasks but no workers, try to scale up
        const totalQueued = this.priorityQueue.length + this.taskQueue.length;
        if (totalQueued > 0 && this.availableWorkers.length === 0 && this.workers.length < this.maxWorkers) {
            this.scaleUpWorkers(Math.min(2, this.maxWorkers - this.workers.length));
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
            workerEfficiency: this.calculateWorkerEfficiency()
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
    if (!ENABLE_MULTITHREADING) {
        throw new Error('Worker pool requested but multithreading is disabled');
    }
    
    if (!workerPool) {
        workerPool = new WorkerPool();
    }
    return workerPool;
}

function inflateBlob(blob, callback, useWorkerThreads = false, priority = 'normal'){
    // Simple path separation based on configuration and request
    if (!ENABLE_MULTITHREADING || !useWorkerThreads) {
        // SINGLE-THREADED PATH: Use main thread zlib directly
        return zlib.inflate(blob.zlibData, callback);
    } else {
        // MULTI-THREADED PATH: Use worker pool (when enabled)
        const pool = getWorkerPool();
        pool.inflateBlob(blob, callback, priority);
    }
}

// Alternative: Stream-based decompression for memory efficiency
function inflateBlobStream(blob, callback) {
    const chunks = [];
    const inflateStream = zlib.createInflate();
    
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

// Alternative: Synchronous decompression (faster for small blocks)
function inflateBlobSync(blob) {
    try {
        return zlib.inflateSync(blob.zlibData);
    } catch (err) {
        throw err;
    }
}

// Get worker pool statistics for monitoring
function getWorkerPoolStats() {
    if (!ENABLE_MULTITHREADING) {
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
            multithreadingEnabled: false
        };
    } else {
        // MULTI-THREADED PATH: Get actual worker pool stats
        const pool = getWorkerPool();
        const stats = pool.getStats();
        stats.multithreadingEnabled = true;
        return stats;
    }
}

// Shutdown worker pool (for cleanup)
function shutdownWorkerPool() {
    if (!ENABLE_MULTITHREADING) {
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

module.exports = {
    inflateBlob: inflateBlob,
    inflateBlobStream: inflateBlobStream,
    inflateBlobSync: inflateBlobSync,
    getWorkerPoolStats: getWorkerPoolStats,
    shutdownWorkerPool: shutdownWorkerPool
};
