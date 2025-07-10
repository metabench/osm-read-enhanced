/**
 * Buffer pool for reusing memory buffers
 * Helps reduce memory fragmentation and GC pressure
 */

class BufferPool {
  constructor(options = {}) {
    this.options = {
      initialPoolSize: options.initialPoolSize || 10,
      maxPoolSize: options.maxPoolSize || 100,
      defaultBufferSize: options.defaultBufferSize || 1024 * 1024, // 1MB default
      maxBufferAge: options.maxBufferAge || 60000, // 1 minute
      cleanupInterval: options.cleanupInterval || 30000 // 30 seconds
    };
    
    // Create pools by size category
    this.pools = new Map();
    
    // Buffer usage tracking
    this.stats = {
      created: 0,
      reused: 0,
      released: 0,
      wasted: 0, // Bytes wasted due to oversized buffers
      totalAllocated: 0,
      resized: 0
    };
    
    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.options.cleanupInterval);
  }
  
  /**
   * Get a buffer of at least the requested size
   * @param {number} size - Minimum buffer size needed
   * @returns {Buffer} A buffer of appropriate size
   */
  acquire(size) {
    const requestedSize = size || this.options.defaultBufferSize;
    
    // Find the appropriate size category
    const sizeCategory = this._getSizeCategory(requestedSize);
    
    if (!this.pools.has(sizeCategory)) {
      this.pools.set(sizeCategory, []);
    }
    
    const pool = this.pools.get(sizeCategory);
    
    // If we have a buffer available, reuse it
    if (pool.length > 0) {
      const buffer = pool.pop();
      buffer.lastUsed = Date.now();
      this.stats.reused++;
      
      // Track wasted space but use a more accurate calculation
      const wastedBytes = buffer.length - requestedSize;
      this.stats.wasted += wastedBytes;
      
      if (wastedBytes > requestedSize) {
        // If wasting more than 50%, log it
        console.log(`BufferPool: Inefficient buffer use - requested ${requestedSize} bytes, using ${buffer.length} bytes buffer`);
      }
      
      // Zero out the buffer for safety (prevents data leakage)
      // Only zero out the part that will be used
      buffer.fill(0, 0, requestedSize);
      
      return buffer;
    }
    
    // Otherwise create a new buffer
    const newBuffer = Buffer.allocUnsafe(sizeCategory);
    newBuffer.lastUsed = Date.now();
    this.stats.created++;
    this.stats.totalAllocated += sizeCategory;
    
    // Zero out the buffer for safety
    newBuffer.fill(0);
    
    return newBuffer;
  }
  
  /**
   * Release a buffer back to the pool
   * @param {Buffer} buffer - The buffer to release
   */
  release(buffer) {
    if (!Buffer.isBuffer(buffer)) return;
    
    const sizeCategory = this._getSizeCategory(buffer.length);
    
    if (!this.pools.has(sizeCategory)) {
      this.pools.set(sizeCategory, []);
    }
    
    const pool = this.pools.get(sizeCategory);
    
    // Only add to pool if we're under the max size
    if (pool.length < this.options.maxPoolSize) {
      buffer.lastUsed = Date.now();
      pool.push(buffer);
      this.stats.released++;
    }
  }
  
  /**
   * Clean up old buffers to prevent memory leaks
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    
    for (const [size, pool] of this.pools.entries()) {
      // Remove buffers that haven't been used recently
      const freshBuffers = pool.filter(buffer => {
        const isRecent = (now - buffer.lastUsed) < this.options.maxBufferAge;
        if (!isRecent) removed++;
        return isRecent;
      });
      
      // Replace pool with filtered list
      this.pools.set(size, freshBuffers);
    }
    
    return removed;
  }
  
  /**
   * Get statistics about pool usage
   */
  getStats() {
    let pooledBufferCount = 0;
    let pooledMemory = 0;
    
    for (const [size, pool] of this.pools.entries()) {
      pooledBufferCount += pool.length;
      pooledMemory += size * pool.length;
    }
    
    return {
      ...this.stats,
      pooledBufferCount,
      pooledMemory,
      pooledMemoryMB: pooledMemory / (1024 * 1024),
      wastagePercent: this.stats.wasted > 0 ? 
        (this.stats.wasted / this.stats.totalAllocated * 100).toFixed(2) : 0,
      reuseRate: this.stats.created > 0 ?
        (this.stats.reused / (this.stats.created + this.stats.reused) * 100).toFixed(2) : 0
    };
  }
  
  /**
   * Round up to nearest power of 2 to categorize buffer sizes
   * @private
   */
  _getSizeCategory(size) {
    // Use power-of-2 size categories with a minimum of 4KB
    const minSize = 4096; // 4KB minimum
    
    if (size <= minSize) return minSize;
    
    // Find next power of 2
    let power = Math.ceil(Math.log2(size));
    return Math.pow(2, power);
  }
  
  /**
   * Clean up resources
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clear all pools
    this.pools.clear();
  }
  
  /**
   * Resize the buffer pool
   * @param {number} newMaxSize - The new maximum pool size
   */
  resize(newMaxSize) {
    // If reducing the pool size
    if (newMaxSize < this.options.maxPoolSize) {
      for (const [size, pool] of this.pools.entries()) {
        if (pool.length > newMaxSize) {
          // Remove excess buffers from the end of the pool (typically larger ones)
          this.pools.set(size, pool.slice(0, newMaxSize));
        }
      }
      this.stats.resized++;
    }
    
    this.options.maxPoolSize = newMaxSize;
  }
}

module.exports = BufferPool;
