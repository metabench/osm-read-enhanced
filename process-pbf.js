/**
 * Memory-optimized processor for OSM PBF files
 */
const OSM_PBF_Parser_Decompress = require('./lib/OSM_PBF_Parser_Decompress');
const MemoryLeakDetector = require('./lib/memory-leak-detector');
const MemoryManager = require('./lib/memory-manager');
const path = require('path');
const os = require('os');

// Get command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node process-pbf.js <pbf-file>');
  process.exit(1);
}

const pbfFile = args[0];
const memoryLimit = process.env.OSM_PARSER_MEMORY_LIMIT || 2 * 1024 * 1024 * 1024; // 2GB default

// Initialize memory monitoring
const memoryManager = new MemoryManager({
  heapLimit: memoryLimit,
  forceGc: typeof global.gc === 'function'
});

const leakDetector = new MemoryLeakDetector();
leakDetector.start();

// Count processed entities
let nodeCount = 0;
let wayCount = 0;
let relationCount = 0;
let lastReportTime = Date.now();

// Create parser with optimized settings
const parser = new OSM_PBF_Parser_Decompress(pbfFile, {
  verbose: false,
  // Keep 4 workers as requested
  workerCount: 4,
  // But optimize other memory settings
  maxQueueSize: 15, // Smaller queue size
  minTaskSize: 256 * 1024, // Only parallelize larger blobs
  maxMemoryUsage: memoryLimit * 0.9, // 90% of available memory
  useBufferPool: true,
  bufferPoolSize: 30, // Smaller buffer pool
  highWaterMark: 4 * 1024 * 1024, // 4MB chunks
  strictErrorMode: true
});

parser.on('start', (event) => {
  console.log(`Started reading ${event.file_path} (size: ${(event.file_size / (1024 * 1024)).toFixed(2)}MB)`);
});

// Set up the OSM entity handlers
parser.on('node', () => {
  nodeCount++;
  reportProgress();
});

parser.on('way', () => {
  wayCount++;
  reportProgress();
});

parser.on('relation', () => {
  relationCount++;
  reportProgress();
});

parser.on('error', (err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

parser.on('end', (event) => {
  const memStats = memoryManager.getStats();
  console.log(`\nCompleted parsing in ${event.elapsed?.toFixed(1) || 'N/A'}s`);
  console.log(`Processed: ${nodeCount.toLocaleString()} nodes, ${wayCount.toLocaleString()} ways, ${relationCount.toLocaleString()} relations`);
  console.log(`Total data processed: ${event.total_mb || '0'}MB, Speed: ${event.overall_mb_s || '0'}MB/s`);
  console.log(`Peak memory usage: ${memStats.maxHeapUsedMB.toFixed(2)}MB`);
  
  leakDetector.stop();
  memoryManager.shutdown();
  
  if (typeof global.gc === 'function') {
    global.gc();
  }
});

// Report progress periodically
function reportProgress() {
  const now = Date.now();
  if (now - lastReportTime > 5000) { // Every 5 seconds
    const memUsage = process.memoryUsage();
    const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
    const rssMB = memUsage.rss / (1024 * 1024);
    
    console.log(`Progress: ${nodeCount.toLocaleString()} nodes, ${wayCount.toLocaleString()} ways, ${relationCount.toLocaleString()} relations`);
    console.log(`Memory: ${heapUsedMB.toFixed(2)}MB heap, ${rssMB.toFixed(2)}MB total`);
    
    lastReportTime = now;
  }
}

// Start parsing
const parserControl = parser.parse();

// Handle SIGINT
process.on('SIGINT', () => {
  console.log('Received SIGINT, cleaning up...');
  if (parserControl && parserControl.cleanup) {
    parserControl.cleanup();
  }
  process.exit(0);
});
