/**
 * Memory profiling utilities for OSM PBF parser
 * Helps monitor and optimize memory usage during parsing
 */

// Track memory usage over time
class MemoryProfiler {
  constructor(options = {}) {
    this.options = Object.assign({
      interval: 5000, // Check every 5 seconds
      heapWarningThreshold: 1024 * 1024 * 1024, // 1GB
      onWarning: null,
      onReport: null,
      logToConsole: true,
      autoGc: false // Whether to auto-trigger garbage collection
    }, options);
    
    this.samples = [];
    this.intervalId = null;
    this.startTime = Date.now();
    this.maxHeapUsed = 0;
    this.lastGcTime = 0;
    this.gcCount = 0;
    this.warningCount = 0;
    
    // Check if GC is available
    this.hasGc = typeof global.gc === 'function';
    if (this.options.autoGc && !this.hasGc) {
      console.warn('Auto GC requested but Node.js was not started with --expose-gc flag');
    }
  }
  
  start() {
    if (this.intervalId) return; // Already started
    
    this.startTime = Date.now();
    this.samples = [];
    this.maxHeapUsed = 0;
    
    this.intervalId = setInterval(() => this._checkMemory(), this.options.interval);
    this._checkMemory(); // Take initial sample
    
    return this; // For chaining
  }
  
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    // Take final sample
    this._checkMemory();
    
    return this; // For chaining
  }
  
  forceGc() {
    if (this.hasGc) {
      const before = process.memoryUsage().heapUsed;
      global.gc();
      const after = process.memoryUsage().heapUsed;
      this.gcCount++;
      this.lastGcTime = Date.now();
      
      return {
        before: before / (1024 * 1024),
        after: after / (1024 * 1024),
        freed: (before - after) / (1024 * 1024)
      };
    }
    return null;
  }
  
  getReport() {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    
    return {
      currentMemoryMb: this.samples.length ? this.samples[this.samples.length - 1].heapUsedMb : 0,
      maxMemoryMb: this.maxHeapUsed / (1024 * 1024),
      sampleCount: this.samples.length,
      gcCount: this.gcCount,
      warningCount: this.warningCount,
      elapsedSeconds: elapsed,
      memoryTrend: this._calculateTrend()
    };
  }
  
  _checkMemory() {
    const memoryUsage = process.memoryUsage();
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    
    // Record heap usage
    const heapUsed = memoryUsage.heapUsed;
    if (heapUsed > this.maxHeapUsed) {
      this.maxHeapUsed = heapUsed;
    }
    
    // Add sample
    const sample = {
      timestamp: now,
      elapsedSeconds: elapsed,
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: heapUsed,
      external: memoryUsage.external,
      rssMb: memoryUsage.rss / (1024 * 1024),
      heapTotalMb: memoryUsage.heapTotal / (1024 * 1024),
      heapUsedMb: heapUsed / (1024 * 1024),
      externalMb: memoryUsage.external / (1024 * 1024)
    };
    
    this.samples.push(sample);
    
    // Check for memory warnings
    if (heapUsed > this.options.heapWarningThreshold) {
      this.warningCount++;
      
      // Log warning
      if (this.options.logToConsole) {
        console.warn(`Memory warning: Heap usage at ${sample.heapUsedMb.toFixed(2)}MB ` +
                    `(${(heapUsed / this.options.heapWarningThreshold * 100).toFixed(1)}% of threshold)`);
      }
      
      // Trigger callback if provided
      if (this.options.onWarning) {
        this.options.onWarning(sample);
      }
      
      // Auto-trigger GC if enabled
      if (this.options.autoGc && this.hasGc && (now - this.lastGcTime > 10000)) { // Don't GC more than once every 10 seconds
        const gcResult = this.forceGc();
        if (this.options.logToConsole && gcResult) {
          console.log(`Forced GC: Freed ${gcResult.freed.toFixed(2)}MB, ` +
                      `heap now at ${gcResult.after.toFixed(2)}MB`);
        }
      }
    }
    
    // Log report if enabled
    if (this.options.logToConsole && this.samples.length % 12 === 0) { // Report every ~minute if interval is 5s
      const report = this.getReport();
      console.log(`Memory usage: ${sample.heapUsedMb.toFixed(2)}MB, ` +
                 `max: ${report.maxMemoryMb.toFixed(2)}MB, ` +
                 `trend: ${report.memoryTrend}`);
    }
    
    // Trigger report callback if provided
    if (this.options.onReport) {
      this.options.onReport(sample);
    }
  }
  
  _calculateTrend() {
    if (this.samples.length < 10) return 'insufficient data';
    
    // Use last 10 samples to calculate trend
    const recentSamples = this.samples.slice(-10);
    const firstUsage = recentSamples[0].heapUsed;
    const lastUsage = recentSamples[recentSamples.length - 1].heapUsed;
    
    const percentChange = ((lastUsage - firstUsage) / firstUsage) * 100;
    
    if (percentChange < -5) return 'decreasing';
    if (percentChange > 5) return 'increasing';
    return 'stable';
  }
}

module.exports = MemoryProfiler;