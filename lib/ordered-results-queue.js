/**
 * A utility class that ensures results from parallel operations 
 * are processed in the correct order
 */
class OrderedResultsQueue {
  constructor() {
    this.queue = new Map();  // Map of ID -> result
    this.nextId = 0;         // Next expected ID to process
    this.callbacks = new Map(); // Map of ID -> callback for that result
  }
  
  /**
   * Add a result to the queue
   * @param {number} id - The sequence ID of this result
   * @param {*} result - The result data 
   * @param {Function} callback - The callback to execute when this result is processed
   */
  addResult(id, result, callback) {
    // Store callback for this ID
    this.callbacks.set(id, callback);
    
    // Store the result
    this.queue.set(id, result);
    
    // Process any results that are now ready
    this._processReadyResults();
  }
  
  /**
   * Process any results that are ready to be handled in order
   * @private
   */
  _processReadyResults() {
    // Process results in sequence as long as we have the next expected ID
    while (this.queue.has(this.nextId)) {
      const result = this.queue.get(this.nextId);
      const callback = this.callbacks.get(this.nextId);
      
      // Remove from queue and callbacks
      this.queue.delete(this.nextId);
      this.callbacks.delete(this.nextId);
      
      // Execute callback with this result
      if (callback) {
        try {
          callback(result);
        } catch (err) {
          console.error(`Error processing result ${this.nextId}:`, err);
        }
      }
      
      // Move to next ID
      this.nextId++;
    }
  }
  
  /**
   * Get the number of results waiting in the queue
   */
  get size() {
    return this.queue.size;
  }
  
  /**
   * Clear the queue and reset state
   */
  clear() {
    this.queue.clear();
    this.callbacks.clear();
    this.nextId = 0;
  }
}

module.exports = OrderedResultsQueue;
