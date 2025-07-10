// Minimal worker implementation
const { parentPort } = require('worker_threads');
const zlib = require('zlib');

// Signal when ready
parentPort.postMessage({ type: 'ready' });

// Handle messages
parentPort.on('message', (message) => {
  if (message.type === 'ping') {
    // Health check
    parentPort.postMessage({ type: 'pong' });
    return;
  }
  
  // Extract task info
  const { id, data, format } = message;
  
  // Early validation
  if (!id || !data) {
    parentPort.postMessage({
      type: 'error',
      id: id || 'unknown',
      error: { message: 'Missing task ID or data' }
    });
    return;
  }
  
  // Choose decompression function
  let decompressor;
  if (format === 'gzip') {
    decompressor = zlib.gunzip;
  } else if (format === 'raw') {
    decompressor = zlib.inflateRaw;
  } else {
    decompressor = zlib.inflate;
  }
  
  // Perform decompression
  decompressor(data, (err, result) => {
    if (err) {
      // Report error
      parentPort.postMessage({
        type: 'error',
        id,
        error: { 
          message: `Decompression failed: ${err.message}`,
          name: err.name,
          code: err.code
        }
      });
      return;
    }
    
    try {
      // Send result
      parentPort.postMessage({
        type: 'success',
        id,
        length: result.length,
        decompressedData: result
      });
      
      // Help GC
      setImmediate(() => {
        // Explicitly null references
        result = null;
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        id,
        error: { message: `Failed to send result: ${error.message}` }
      });
    }
  });
});

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  parentPort.postMessage({
    type: 'error',
    id: 'system',
    error: { message: `Uncaught exception: ${error.message}` }
  });
});
