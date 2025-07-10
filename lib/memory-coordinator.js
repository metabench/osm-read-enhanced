/**
 * Memory coordinator - centralizes memory management across components
 * Implements aggressive memory limits and coordinates pausing/throttling
 */
const EventEmitter = require('events');

class MemoryCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxMemoryMB: options.maxMemoryMB || 1024, // 1GB default strict limit
      warningThresholdPercent: options.warningThresholdPercent || 60,
      criticalThresholdPercent: options.criticalThresholdPercent || 80,
      checkIntervalMs: options.checkIntervalMs || 1000,
      verbose: options.verbose || false,
      ...options
    };
    
    // Convert MB to bytes for internal calculations
    this.maxMemoryBytes = this.options.maxMemoryMB * 1024 * 1024;
    this.warningThresholdBytes = this.maxMemoryBytes * (this.options.warningThresholdPercent / 100);
    this.criticalThresholdBytes = this.maxMemoryBytes * (this.options.criticalThresholdPercent / 100);
    
    // Status tracking
    this.status = {
      currentMode: 'normal', // 'normal', 'warning', 'critical', 'paused'
      memoryCheckCount: 0,
      warningCount: 0,
      criticalCount: 0,
      pauseCount: 0,
      lastGcTime: 0,
      lastMemoryUsage: null
    };
    
    // Component status tracking
    this.components = new Map();
    
    // Start memory monitoring
    this.checkIntervalId = setInterval(() => this.checkMemory(), this.options.checkIntervalMs);
    
    // Register process exit handler
    process.on('exit', () => this.shutdown());
  }
  
  /**
   * Register a component that should be monitored and controlled
   */
  registerComponent(id, component, controlFunctions = {}) {
    this.components.set(id, {
      component,
      controls: {
        pause: controlFunctions.pause || (() => {}),
        resume: controlFunctions.resume || (() => {}),
        reduceMemory: controlFunctions.reduceMemory || (() => {})
      },
      status: {
        isPaused: false,
        memoryUsage: 0
      }
    });
    
    if (this.options.verbose) {
      console.log(`MemoryCoordinator: Registered component ${id}`);
    }
    
    return {
      reportMemoryUsage: (bytes) => this.reportComponentMemory(id, bytes),
      requestPause: () => this.requestComponentPause(id),
      requestResume: () => this.requestComponentResume(id)
    };
  }
  
  /**
   * Allow components to report their memory usage
   */
  reportComponentMemory(id, bytes) {
    const component = this.components.get(id);
    if (component) {
      component.status.memoryUsage = bytes;
    }
  }
  
  /**
   * Request a component to pause (will be coordinated)
   */
  requestComponentPause(id) {
    const component = this.components.get(id);
    if (component && !component.status.isPaused) {
      component.status.isPaused = true;
      component.controls.pause();
      this.emit('component-paused', { id });
      
      if (this.options.verbose) {
        console.log(`MemoryCoordinator: Component ${id} paused`);
      }
    }
  }
  
  /**
   * Request a component to resume (will be coordinated)
   */
  requestComponentResume(id) {
    const component = this.components.get(id);
    if (component && component.status.isPaused) {
      component.status.isPaused = false;
      component.controls.resume();
      this.emit('component-resumed', { id });
      
      if (this.options.verbose) {
        console.log(`MemoryCoordinator: Component ${id} resumed`);
      }
    }
  }
  
  /**
   * Check process memory usage and take action
   */
  checkMemory() {
    this.status.memoryCheckCount++;
    
    const memUsage = process.memoryUsage();
    const heapUsed = memUsage.heapUsed;
    const rss = memUsage.rss;
    
    // Store for reporting
    this.status.lastMemoryUsage = {
      heapUsed,
      rss,
      external: memUsage.external
    };
    
    // Calculate effective memory (prioritize RSS over heap)
    const effectiveMemory = Math.max(heapUsed, rss);
    
    // Calculate thresholds based on RSS
    const rssMB = rss / (1024 * 1024);
    const rssWarningThresholdMB = this.options.maxMemoryMB * 0.6;
    const rssCriticalThresholdMB = this.options.maxMemoryMB * 0.8;
    
    // Determine status based on RSS
    let newStatus = 'normal';
    let actionTaken = false;
    
    if (rssMB > rssCriticalThresholdMB) {
      newStatus = 'critical';
      this.status.criticalCount++;
      actionTaken = this._handleCriticalMemory(rssMB);
    } 
    else if (rssMB > rssWarningThresholdMB) {
      newStatus = 'warning';
      this.status.warningCount++;
      actionTaken = this._handleWarningMemory(rssMB);
    }
    else if (this.status.currentMode !== 'normal') {
      // We were in a non-normal state but now memory usage is acceptable
      this._handleRecovery();
    }
    
    // Update status
    const oldStatus = this.status.currentMode;
    this.status.currentMode = newStatus;
    
    // Emit events if status changed
    if (oldStatus !== newStatus) {
      this.emit('status-change', { 
        from: oldStatus, 
        to: newStatus,
        memoryUsage: {
          heapUsed, 
          rss,
          heapUsedMB: (heapUsed / (1024 * 1024)).toFixed(1),
          rssMB: (rss / (1024 * 1024)).toFixed(1),
          percent: ((effectiveMemory / this.maxMemoryBytes) * 100).toFixed(1)
        }
      });
      
      // Log memory status change
      if (this.options.verbose || newStatus === 'critical') {
        console.log(`MemoryCoordinator: Status changed from ${oldStatus} to ${newStatus} - ` +
                   `Heap: ${(heapUsed / (1024 * 1024)).toFixed(1)}MB, ` +
                   `RSS: ${(rss / (1024 * 1024)).toFixed(1)}MB`);
      }
    }
    
    // Calculate total component memory (FIX: missing variable)
    let componentMemory = 0;
    for (const [id, component] of this.components.entries()) {
      componentMemory += component.status.memoryUsage || 0;
    }
    
    // Emit periodic memory stats
    if (this.status.memoryCheckCount % 10 === 0) {
      this.emit('memory-stats', {
        heapUsed,
        rss,
        heapUsedMB: (heapUsed / (1024 * 1024)).toFixed(1),
        rssMB: (rss / (1024 * 1024)).toFixed(1),
        percent: ((effectiveMemory / this.maxMemoryBytes) * 100).toFixed(1),
        componentMemoryMB: (componentMemory / (1024 * 1024)).toFixed(1),
        mode: newStatus
      });
    }
    
    return {
      status: newStatus,
      actionTaken
    };
  }
  
  /**
   * Handle critical memory condition - aggressive action needed
   */
  _handleCriticalMemory(currentMemory) {
    // Instead of relying on heap, use RSS for memory pressure detection
    const memUsage = process.memoryUsage();
    const rssMB = memUsage.rss / (1024 * 1024);
    
    // Adjust threshold based on RSS instead of just heap
    const rssThresholdMB = this.options.maxMemoryMB * 0.8; // Consider 80% of max as critical
    
    if (rssMB > rssThresholdMB) {
      // Log the specific reason for memory pressure
      if (this.options.verbose) {
        console.log(`MemoryCoordinator: Critical RSS memory usage: ${rssMB.toFixed(1)}MB (threshold: ${rssThresholdMB.toFixed(1)}MB)`);
      }
      
      // Pause all components to stop processing and allow memory to be released
      for (const [id, component] of this.components.entries()) {
        if (!component.status.isPaused) {
          this.requestComponentPause(id);
        }
        
        // Also tell component to reduce memory if possible
        if (component.controls.reduceMemory) {
          component.controls.reduceMemory('critical');
        }
      }
      
      this.status.pauseCount++;
      this.emit('critical-memory', { currentMemory });
      
      // Create a small delay between actions to help memory settle
      setTimeout(() => {
        this.suggestMemoryOptimization();
      }, 200);
      
      return true; // Action taken
    }
    
    return false; // No action needed
  }
  
  /**
   * Handle warning memory condition - take preventative action
   */
  _handleWarningMemory(currentMemory) {
    // Less aggressive than critical - just reduce workload
    let actionTaken = false;
    
    // Try garbage collection if available and not done recently
    const now = Date.now();
    if (global.gc && (now - this.status.lastGcTime) > 10000) {
      if (this.options.verbose) {
        console.log(`MemoryCoordinator: Suggesting garbage collection due to warning level memory`);
      }
      global.gc();
      this.status.lastGcTime = now;
      actionTaken = true;
    }
    
    // Tell components to reduce memory usage
    for (const [id, component] of this.components.entries()) {
      component.controls.reduceMemory && component.controls.reduceMemory('warning');
      actionTaken = true;
    }
    
    // Pause heaviest component if multiple are registered
    if (this.components.size > 1) {
      let heaviestId = null;
      let heaviestMemory = 0;
      
      for (const [id, component] of this.components.entries()) {
        if (!component.status.isPaused && component.status.memoryUsage > heaviestMemory) {
          heaviestId = id;
          heaviestMemory = component.status.memoryUsage;
        }
      }
      
      if (heaviestId) {
        this.requestComponentPause(heaviestId);
        actionTaken = true;
      }
    }
    
    this.emit('warning-memory', { currentMemory });
    
    return actionTaken;
  }
  
  /**
   * Handle recovery from memory pressure
   */
  _handleRecovery() {
    // Resume components that were paused due to memory pressure
    this._resumeSelectedComponents();
    
    this.emit('memory-recovered');
    
    if (this.options.verbose) {
      console.log(`MemoryCoordinator: Memory pressure reduced, resuming components`);
    }
    
    return true;
  }
  
  /**
   * Resume selected components based on priority
   */
  _resumeSelectedComponents() {
    // Get all paused components
    const pausedComponents = Array.from(this.components.entries())
      .filter(([id, component]) => component.status.isPaused)
      .map(([id]) => id);
      
    // Resume in priority order (we could add priority later)
    // For now just resume the first one to avoid resuming all at once
    if (pausedComponents.length > 0) {
      this.requestComponentResume(pausedComponents[0]);
    }
  }
  
  /**
   * Get current memory usage and status
   */
  getStats() {
    const memUsage = this.status.lastMemoryUsage || process.memoryUsage();
    
    return {
      heapUsedMB: (memUsage.heapUsed / (1024 * 1024)).toFixed(1),
      rssMB: (memUsage.rss / (1024 * 1024)).toFixed(1),
      externalMB: memUsage.external ? (memUsage.external / (1024 * 1024)).toFixed(1) : '0.0',
      percentUsed: ((memUsage.heapUsed / this.maxMemoryBytes) * 100).toFixed(1),
      currentMode: this.status.currentMode,
      memoryCheckCount: this.status.memoryCheckCount,
      warningCount: this.status.warningCount,
      criticalCount: this.status.criticalCount,
      pauseCount: this.status.pauseCount,
      components: Array.from(this.components.keys()).map(id => ({
        id,
        paused: this.components.get(id).status.isPaused,
        memoryUsage: this.components.get(id).status.memoryUsage
      }))
    };
  }
  
  /**
   * Clean up resources
   */
  shutdown() {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
    
    // Clear status to aid garbage collection
    this.components.clear();
    this.status.lastMemoryUsage = null;
    
    if (this.options.verbose) {
      console.log(`MemoryCoordinator: Shutdown complete`);
    }
  }

  /**
   * Suggest memory optimization without GC
   */
  suggestMemoryOptimization() {
    // Log advice for running with --expose-gc if memory pressure is persistent
    if (this.status.criticalCount > 5 && this.options.verbose) {
      console.log(`Memory pressure is persistent. For better performance, consider:
      1. Increasing the heap limit with --max-old-space-size=<SIZE>
      2. Running with --expose-gc flag for manual garbage collection
      3. Processing smaller chunks of data at a time`);
    }
    
    // Perform immediate actions to reduce memory pressure
    // 1. Clear any object caches in components 
    for (const [id, component] of this.components.entries()) {
      if (component.controls.reduceMemory) {
        component.controls.reduceMemory('warning');
      }
    }
    
    // 2. Run several immediate functions to help trigger Node's GC
    setImmediate(() => {});
    setTimeout(() => {}, 0);
    
    // 3. Create and drop a large object (can help trigger GC in some cases)
    try {
      const tempArray = new Array(10000).fill(0);
      tempArray.length = 0; // Clear the array
    } catch (e) {
      // Ignore errors - this is just an attempt to nudge GC
    }
  }
}

module.exports = MemoryCoordinator;
