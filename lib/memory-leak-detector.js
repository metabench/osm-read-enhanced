/**
 * Simple utility to help track potential memory leaks
 */
class MemoryLeakDetector {
  constructor(options = {}) {
    this.options = {
      sampleInterval: options.sampleInterval || 10000, // 10 seconds
      growthThreshold: options.growthThreshold || 0.1, // 10% growth is suspicious
      itemCountThreshold: options.itemCountThreshold || 1000,
      ...options
    };
    
    this.samplesCount = 0;
    this.lastSample = null;
    this.lastSampleTime = 0;
    this.running = false;
    this.objectCounts = {}; // Track object type counts
  }
  
  /**
   * Start monitoring for potential memory leaks
   */
  start() {
    if (this.running) return;
    
    this.running = true;
    this.lastSampleTime = Date.now();
    this.takeSample();
    
    this.intervalId = setInterval(() => {
      this.takeSample();
    }, this.options.sampleInterval);
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    if (!this.running) return;
    
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  
  /**
   * Register an object type for tracking
   */
  trackObject(type, obj) {
    if (!this.objectCounts[type]) {
      this.objectCounts[type] = new WeakSet();
    }
    
    this.objectCounts[type].add(obj);
  }
  
  /**
   * Take a memory sample and analyze it
   */
  takeSample() {
    this.samplesCount++;
    const memUsage = process.memoryUsage();
    const sample = {
      timestamp: Date.now(),
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external
    };
    
    // If we have a previous sample, analyze growth
    if (this.lastSample) {
      const elapsedSec = (sample.timestamp - this.lastSample.timestamp) / 1000;
      const heapGrowth = sample.heapUsed - this.lastSample.heapUsed;
      const growthPercent = heapGrowth / this.lastSample.heapUsed;
      const growthRate = heapGrowth / elapsedSec; // bytes per second
      
      sample.growth = {
        bytes: heapGrowth,
        percent: growthPercent,
        ratePerSec: growthRate
      };
      
      // Check for significant growth
      if (growthPercent > this.options.growthThreshold) {
        console.warn(`⚠️ Potential memory leak detected: ${(growthPercent * 100).toFixed(1)}% heap growth in ${elapsedSec.toFixed(1)}s`);
        console.warn(`Heap usage: ${(sample.heapUsed / 1024 / 1024).toFixed(2)}MB, growth rate: ${(growthRate / 1024 / 1024).toFixed(2)}MB/s`);
        
        // If global.gc is available, try garbage collection and measure again
        if (typeof global.gc === 'function') {
          console.log('Attempting garbage collection...');
          global.gc();
          
          // Measure after GC
          const afterGc = process.memoryUsage();
          const recovered = sample.heapUsed - afterGc.heapUsed;
          console.log(`After GC: ${(afterGc.heapUsed / 1024 / 1024).toFixed(2)}MB (recovered ${(recovered / 1024 / 1024).toFixed(2)}MB)`);
          
          // Update sample with post-GC values
          sample.heapUsed = afterGc.heapUsed;
          sample.heapTotal = afterGc.heapTotal;
          sample.rss = afterGc.rss;
          sample.external = afterGc.external;
          sample.gcRan = true;
          sample.gcRecovered = recovered;
        }
      }
    }
    
    this.lastSample = sample;
    return sample;
  }
  
  /**
   * Get the current memory status with analysis
   */
  getStatus() {
    const current = process.memoryUsage();
    
    return {
      currentHeapMB: current.heapUsed / 1024 / 1024,
      samplesCount: this.samplesCount,
      lastSample: this.lastSample,
      objectCounts: Object.keys(this.objectCounts).reduce((acc, type) => {
        // We can't count WeakSet contents directly
        acc[type] = '≥1'; // Just indicate it's being tracked
        return acc;
      }, {})
    };
  }
}

module.exports = MemoryLeakDetector;
