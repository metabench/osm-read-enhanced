/**
 * Performance monitoring utilities for OSM PBF processing
 */
const EventEmitter = require('events');
const os = require('os');

class PerformanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = Object.assign({
      sampleInterval: 1000, // 1 second
      reportInterval: 10000, // 10 seconds
      enableDetailedCpuProfiling: false,
      trackMemory: true,
      trackCpu: true
    }, options);
    
    this.metrics = {
      startTime: Date.now(),
      lastReportTime: Date.now(),
      cpuUsage: {
        user: 0,
        system: 0
      },
      memoryUsage: {
        rss: 0,
        heapTotal: 0,
        heapUsed: 0,
        external: 0
      },
      processingMetrics: {
        bytesRead: 0,
        bytesDecompressed: 0,
        nodesProcessed: 0,
        waysProcessed: 0,
        relationsProcessed: 0
      },
      samples: [],
      maxSamples: 60 // Keep last minute of samples
    };
    
    this.totalCpuCores = os.cpus().length;
    this.sampleTimer = null;
    this.reportTimer = null;
  }
  
  start() {
    if (this.sampleTimer) return this;
    
    this.metrics.startTime = Date.now();
    this.metrics.lastReportTime = Date.now();
    this.metrics.samples = [];
    
    // Start sampling metrics
    this.sampleTimer = setInterval(() => {
      this.takeSample();
    }, this.options.sampleInterval);
    
    // Start reporting metrics
    this.reportTimer = setInterval(() => {
      this.generateReport();
    }, this.options.reportInterval);
    
    return this;
  }
  
  stop() {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    
    return this;
  }
  
  takeSample() {
    const now = Date.now();
    const sample = {
      timestamp: now,
      elapsed: (now - this.metrics.startTime) / 1000
    };
    
    // Sample CPU usage
    if (this.options.trackCpu) {
      sample.cpu = process.cpuUsage(this.metrics.cpuUsage);
      this.metrics.cpuUsage = process.cpuUsage();
      
      // Calculate CPU percentage (user + system)
      const totalCpuTime = sample.cpu.user + sample.cpu.system;
      const elapsedMicros = this.options.sampleInterval * 1000;
      sample.cpuPercent = (totalCpuTime / elapsedMicros) * 100;
      
      // This will be > 100% for multi-core usage
      sample.cpuPercentPerCore = sample.cpuPercent / this.totalCpuCores;
    }
    
    // Sample memory usage
    if (this.options.trackMemory) {
      sample.memory = process.memoryUsage();
      this.metrics.memoryUsage = sample.memory;
      
      // Calculate memory in MB
      sample.memoryMB = {
        rss: sample.memory.rss / (1024 * 1024),
        heapTotal: sample.memory.heapTotal / (1024 * 1024),
        heapUsed: sample.memory.heapUsed / (1024 * 1024),
        external: sample.memory.external / (1024 * 1024)
      };
    }
    
    // Add to samples
    this.metrics.samples.push(sample);
    
    // Limit samples array size
    if (this.metrics.samples.length > this.metrics.maxSamples) {
      this.metrics.samples.shift();
    }
    
    // Emit sample
    this.emit('sample', sample);
  }
  
  generateReport() {
    const now = Date.now();
    const elapsed = (now - this.metrics.startTime) / 1000;
    const sinceLastReport = (now - this.metrics.lastReportTime) / 1000;
    this.metrics.lastReportTime = now;
    
    // Get latest metrics
    const memory = this.options.trackMemory ? process.memoryUsage() : null;
    
    const report = {
      timestamp: now,
      elapsed,
      sinceLastReport,
      cpu: {
        totalCores: this.totalCpuCores,
        average: this._calculateAverageCpu()
      },
      memory: memory ? {
        rss: memory.rss / (1024 * 1024),
        heapTotal: memory.heapTotal / (1024 * 1024),
        heapUsed: memory.heapUsed / (1024 * 1024),
        external: memory.external / (1024 * 1024)
      } : null,
      processing: {
        bytesRead: this.metrics.processingMetrics.bytesRead,
        bytesDecompressed: this.metrics.processingMetrics.bytesDecompressed,
        nodesProcessed: this.metrics.processingMetrics.nodesProcessed,
        waysProcessed: this.metrics.processingMetrics.waysProcessed,
        relationsProcessed: this.metrics.processingMetrics.relationsProcessed
      },
      rates: {
        readMBps: sinceLastReport > 0 ? 
          (this.metrics.processingMetrics.bytesRead / (1024 * 1024)) / sinceLastReport : 0,
        decompressedMBps: sinceLastReport > 0 ? 
          (this.metrics.processingMetrics.bytesDecompressed / (1024 * 1024)) / sinceLastReport : 0,
        nodesPerSec: sinceLastReport > 0 ? 
          this.metrics.processingMetrics.nodesProcessed / sinceLastReport : 0,
        waysPerSec: sinceLastReport > 0 ? 
          this.metrics.processingMetrics.waysProcessed / sinceLastReport : 0,
        relationsPerSec: sinceLastReport > 0 ? 
          this.metrics.processingMetrics.relationsProcessed / sinceLastReport : 0
      }
    };
    
    // Reset processing metrics for next interval
    this.metrics.processingMetrics = {
      bytesRead: 0,
      bytesDecompressed: 0,
      nodesProcessed: 0,
      waysProcessed: 0,
      relationsProcessed: 0
    };
    
    // Emit report
    this.emit('report', report);
    
    return report;
  }
  
  _calculateAverageCpu() {
    if (this.metrics.samples.length === 0) {
      return { percent: 0, percentPerCore: 0 };
    }
    
    // Calculate average CPU usage over all samples
    let totalPercent = 0;
    let totalPercentPerCore = 0;
    let sampleCount = 0;
    
    this.metrics.samples.forEach(sample => {
      if (sample.cpuPercent !== undefined) {
        totalPercent += sample.cpuPercent;
        totalPercentPerCore += sample.cpuPercentPerCore;
        sampleCount++;
      }
    });
    
    if (sampleCount === 0) {
      return { percent: 0, percentPerCore: 0 };
    }
    
    return {
      percent: totalPercent / sampleCount,
      percentPerCore: totalPercentPerCore / sampleCount
    };
  }
  
  // Methods to update processing metrics
  updateBytesRead(bytes) {
    this.metrics.processingMetrics.bytesRead += bytes;
    return this;
  }
  
  updateBytesDecompressed(bytes) {
    this.metrics.processingMetrics.bytesDecompressed += bytes;
    return this;
  }
  
  updateNodesProcessed(count = 1) {
    this.metrics.processingMetrics.nodesProcessed += count;
    return this;
  }
  
  updateWaysProcessed(count = 1) {
    this.metrics.processingMetrics.waysProcessed += count;
    return this;
  }
  
  updateRelationsProcessed(count = 1) {
    this.metrics.processingMetrics.relationsProcessed += count;
    return this;
  }
}

module.exports = PerformanceMonitor;