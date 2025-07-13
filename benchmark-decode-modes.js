#!/usr/bin/env node

const fs = require('fs');
const { performance } = require('perf_hooks');
const OSMParser = require('./lib/OSM_PBF_Parser_Decode.js');

// Configuration
const TEST_FILE = './test/input/pitcairn-islands-latest.osm.pbf';
const READ_THRESHOLD = '50MB'; // Test with 50MB to get meaningful results
const DECODE_MODES = ['minimal', 'lite', 'standard', 'full'];

// Helper function to parse size strings
function parseSize(sizeStr) {
  const units = { 'B': 1, 'KB': 1024, 'MB': 1024*1024, 'GB': 1024*1024*1024 };
  const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*([A-Z]+)$/i);
  if (!match) return parseInt(sizeStr);
  return Math.floor(parseFloat(match[1]) * units[match[2].toUpperCase()]);
}

// Helper function to format size
function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)}${units[unitIndex]}`;
}

// Helper function to format time
function formatTime(ms) {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function benchmarkDecodeMode(mode) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== BENCHMARKING DECODE MODE: ${mode.toUpperCase()} ===`);
    
    const startTime = performance.now();
    const readThresholdBytes = parseSize(READ_THRESHOLD);
    
    // Create parser with specific decode mode
    const parser = new OSMParser(TEST_FILE, {
      read_threshold: readThresholdBytes,
      timing_verbose: true,
      decode_mode: mode,
      fastMode: false
    });
    
    let blobCount = 0;
    let totalNodes = 0;
    let totalWays = 0;
    let totalRelations = 0;
    let totalBytes = 0;
    let blobTimings = [];
    
    // Track blob processing performance
    parser.on('blob-ready', (data) => {
      blobCount++;
      
      if (data.blob && typeof data.blob.fastParse === 'function') {
        const blobStartTime = performance.now();
        
        // Set up event handlers for this blob
        const blobEmitter = {
          emit: (eventType, eventData) => {
            if (eventType === 'node') totalNodes++;
            else if (eventType === 'way') totalWays++;
            else if (eventType === 'relation') totalRelations++;
            else if (eventType === 'blob_complete') {
              const blobEndTime = performance.now();
              const blobTime = blobEndTime - blobStartTime;
              
              blobTimings.push({
                index: data.blobIndex,
                time: blobTime,
                counts: eventData.counts,
                timing: eventData.timing,
                decode_mode: eventData.decode_mode
              });
              
              console.log(`[BENCHMARK] Blob ${data.blobIndex}: ${eventData.counts.nodes}N/${eventData.counts.ways}W/${eventData.counts.relations}R in ${formatTime(blobTime)}`);
            }
          }
        };
        
        // Parse the blob with timing
        data.blob.fastParse(blobEmitter);
      }
    });
    
    // Track progress
    parser.on('progress', (progressData) => {
      totalBytes = progressData.bytesRead;
      const percent = ((progressData.bytesRead / readThresholdBytes) * 100).toFixed(1);
      const throughput = (progressData.bytesRead / 1024 / 1024) / ((performance.now() - startTime) / 1000);
      console.log(`[PROGRESS] ${formatSize(progressData.bytesRead)}/${READ_THRESHOLD} (${percent}%) - ${throughput.toFixed(1)} MB/s`);
    });
    
    // Handle completion
    parser.on('end', () => {
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      
      // Calculate aggregate statistics
      const avgBlobTime = blobTimings.length > 0 ? 
        blobTimings.reduce((sum, b) => sum + b.time, 0) / blobTimings.length : 0;
      
      const throughputMBps = (totalBytes / 1024 / 1024) / (totalTime / 1000);
      
      const results = {
        mode: mode,
        totalTime: totalTime,
        totalBytes: totalBytes,
        throughputMBps: throughputMBps,
        blobCount: blobCount,
        totalNodes: totalNodes,
        totalWays: totalWays,
        totalRelations: totalRelations,
        avgBlobTime: avgBlobTime,
        blobTimings: blobTimings
      };
      
      console.log(`\n[RESULTS] Mode: ${mode}`);
      console.log(`  Total time: ${formatTime(totalTime)}`);
      console.log(`  Throughput: ${throughputMBps.toFixed(2)} MB/s`);
      console.log(`  Blobs processed: ${blobCount}`);
      console.log(`  Elements: ${totalNodes}N + ${totalWays}W + ${totalRelations}R = ${totalNodes + totalWays + totalRelations}`);
      console.log(`  Avg blob time: ${formatTime(avgBlobTime)}`);
      
      resolve(results);
    });
    
    // Handle errors
    parser.on('error', (err) => {
      console.error(`[ERROR] ${mode}: ${err.message}`);
      reject(err);
    });
    
    // Start parsing
    parser.parse();
  });
}

async function main() {
  console.log('OSM PBF Decode Mode Benchmark');
  console.log('============================');
  console.log(`Test file: ${TEST_FILE}`);
  console.log(`Read threshold: ${READ_THRESHOLD}`);
  console.log(`Decode modes: ${DECODE_MODES.join(', ')}`);
  
  // Check if test file exists
  if (!fs.existsSync(TEST_FILE)) {
    console.error(`Error: Test file ${TEST_FILE} does not exist.`);
    console.log('Please ensure you have a PBF file to test with.');
    process.exit(1);
  }
  
  const allResults = [];
  
  // Run benchmarks for each decode mode
  for (const mode of DECODE_MODES) {
    try {
      const result = await benchmarkDecodeMode(mode);
      allResults.push(result);
      
      // Wait a bit between runs to let system settle
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      console.error(`Failed to benchmark mode ${mode}:`, err.message);
    }
  }
  
  // Print comparison summary
  console.log('\n\n=== DECODE MODE COMPARISON ===');
  console.log('Mode      | Time      | Throughput | Elements  | Avg Blob Time');
  console.log('----------|-----------|------------|-----------|---------------');
  
  allResults.forEach(result => {
    const totalElements = result.totalNodes + result.totalWays + result.totalRelations;
    console.log(`${result.mode.padEnd(9)} | ${formatTime(result.totalTime).padEnd(9)} | ${result.throughputMBps.toFixed(1).padEnd(8)} MB/s | ${totalElements.toString().padEnd(9)} | ${formatTime(result.avgBlobTime)}`);
  });
  
  // Find fastest mode
  if (allResults.length > 0) {
    const fastest = allResults.reduce((prev, curr) => prev.totalTime < curr.totalTime ? prev : curr);
    const slowest = allResults.reduce((prev, curr) => prev.totalTime > curr.totalTime ? prev : curr);
    
    console.log(`\nFastest: ${fastest.mode} (${formatTime(fastest.totalTime)})`);
    console.log(`Slowest: ${slowest.mode} (${formatTime(slowest.totalTime)})`);
    console.log(`Speed improvement: ${(slowest.totalTime / fastest.totalTime).toFixed(2)}x`);
  }
  
  console.log('\nBenchmark complete!');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Benchmark failed:', err.message);
    process.exit(1);
  });
}

module.exports = { benchmarkDecodeMode, parseSize, formatSize, formatTime };
