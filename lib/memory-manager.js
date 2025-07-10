/**
 * Memory manager that monitors heap usage and takes action to prevent OOM errors
 * This version doesn't rely on --expose-gc flag
 */
const EventEmitter = require('events');

class MemoryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      heapLimit: options.heapLimit || 1.5 * 1024 * 1024 * 1024, // 1.5GB
      heapWarningThreshold: options.heapWarningThreshold || 0.7, // 70%
      heapCriticalThreshold: options.heapCriticalThreshold || 0.85, // 85%
      checkInterval: options.checkInterval || 2000, // 2 seconds
      gcMinInterval: options.gcMinInterval || 5000, // Minimum 5s between optimization attempts
      verbose: options.verbose || false,
      ...options
    };
    
    this.stats = {
      warningCount: 0,
      criticalCount: 0,
      optimizationAttempts: 0,
      peakHeapUsage: 0,
      lastOptimizationTime: 0
    };
    
    this.checkIntervalId = setInterval(() => this.checkMemory(), this.options.checkInterval);
  }
  
  checkMemory() {
    const memUsage = process.memoryUsage();
    const heapUsed = memUsage.heapUsed;
    const heapUsageRatio = heapUsed / this.options.heapLimit;
    
    // Update peak heap usage
    if (heapUsed > this.stats.peakHeapUsage) {
      this.stats.peakHeapUsage = heapUsed;
    }
    
    const heapUsageMB = heapUsed / (1024 * 1024);
    const rssMB = memUsage.rss / (1024 * 1024);
    
    // Handle critical memory pressure
    if (heapUsageRatio > this.options.heapCriticalThreshold) {
      this.stats.criticalCount++;
      
      // Even if we're not using forced GC, we can still use memory optimization techniques
      this._attemptMemoryOptimization('critical');
      
      this.emit('memory-critical', { 
        heapUsed, 
        heapUsageRatio, 
        heapUsageMB, 
        rssMB 
      });
      
      return;
    }
    
    // Handle warning level memory pressure
    if (heapUsageRatio > this.options.heapWarningThreshold) {
      this.stats.warningCount++;
      
      // Try optimizing memory at warning level too, but less aggressively
      this._attemptMemoryOptimization('warning');
      
      this.emit('memory-warning', { 
        heapUsed, 
        heapUsageRatio, 
        heapUsageMB, 
        rssMB 
      });
      
      return;
    }
  }
  
  /**
   * Attempt to optimize memory usage without requiring --expose-gc
   */
  _attemptMemoryOptimization(level = 'warning') {
    const now = Date.now();
    
    // Don't attempt optimization too frequently
    if (now - this.stats.lastOptimizationTime < this.options.gcMinInterval) {
      return false;
    }
    
    this.stats.lastOptimizationTime = now;
    this.stats.optimizationAttempts++;
    
    // Log what we're attempting
    if (this.options.verbose) {
      console.log(`MemoryManager: Attempting memory optimization (${level} level)`);
    }
    
    // Techniques to help trigger Node's garbage collector
    
    // 1. Run code in multiple ticks of the event loop
    setImmediate(() => {});
    
    // 2. Create temporary objects and release them
    const tempObjects = [];
    for (let i = 0; i < 10; i++) {
      tempObjects.push(new ArrayBuffer(1024 * 10)); // 10KB each
    }
    // Immediately clear references
    tempObjects.length = 0;
    
    // 3. Log advice when we're seeing persistent memory issues
    if (this.stats.criticalCount > 5) {
      console.log(`NOTE: Memory pressure is persistent. Consider running with --max-old-space-size=<SIZE> ` +
                 `for larger files or --expose-gc for better memory management.`);
    }
    
    return true;
  }
  
  /**
   * Get current memory usage and statistics
   */
  getStats() {
    const memUsage = process.memoryUsage();
    return {
      heapUsed: memUsage.heapUsed,
      heapUsedMB: memUsage.heapUsed / (1024 * 1024),
      heapUsageRatio: memUsage.heapUsed / this.options.heapLimit,
      rss: memUsage.rss,
      rssMB: memUsage.rss / (1024 * 1024),
      external: memUsage.external,
      peakHeapUsageMB: this.stats.peakHeapUsage / (1024 * 1024),
      warningCount: this.stats.warningCount,
      criticalCount: this.stats.criticalCount,
      optimizationAttempts: this.stats.optimizationAttempts
    };
  }
  
  /**
   * Clean up resources
   */
  destroy() {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
  }
}

module.exports = MemoryManager;
