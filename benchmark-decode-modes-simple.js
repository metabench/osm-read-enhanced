#!/usr/bin/env node

const fs = require('fs');
const { performance } = require('perf_hooks');
const OSMParser = require('./lib/OSM_PBF_Parser_Decode.js');

// Configuration
const TEST_FILE = './test/input/pitcairn-islands-latest.osm.pbf';
const READ_THRESHOLD = '1MB'; // Use smaller threshold for this small test file
const DECODE_MODES = ['minimal', 'lite', 'standard', 'full'];

// Helper function to parse size strings
function parseSize(sizeStr) {
  const units = { 'B': 1, 'KB': 1024, 'MB': 1024*1024, 'GB': 1024*1024*1024 };
  const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*([A-Z]+)$/i);
  if (!match) return parseInt(sizeStr);
  return Math.floor(parseFloat(match[1]) * units[match[2].toUpperCase()]);
}

// Helper function to format time
function formatTime(ms) {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function benchmarkDecodeMode(mode) {
  return new Promise((resolve, reject) => {
    console.log(`\\n=== BENCHMARKING DECODE MODE: ${mode.toUpperCase()} ===`);
    
    const startTime = performance.now();
    const readThresholdBytes = parseSize(READ_THRESHOLD);
    
    // Create parser with specific decode mode and reduced timing verbosity
    const parser = new OSMParser(TEST_FILE, {
      read_threshold: readThresholdBytes,
      timing_verbose: false, // Reduce noise
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
            if (eventType === 'node') {
              totalNodes++;
            } else if (eventType === 'way') {
              totalWays++;
            } else if (eventType === 'relation') {
              totalRelations++;
            } else if (eventType === 'blob_complete') {
              const blobEndTime = performance.now();
              const blobTime = blobEndTime - blobStartTime;
              
              blobTimings.push({
                index: data.blobIndex || blobCount,
                time: blobTime,
                counts: eventData.counts || { nodes: 0, ways: 0, relations: 0 },
                decode_mode: eventData.decode_mode || mode
              });
              
              // Add counts from the blob completion event if available
              if (eventData.counts) {
                totalNodes += eventData.counts.nodes;
                totalWays += eventData.counts.ways;
                totalRelations += eventData.counts.relations;
              }
              
              console.log(`[BENCHMARK] Blob ${data.blobIndex || blobCount}: ${eventData.counts?.nodes || 0}N/${eventData.counts?.ways || 0}W/${eventData.counts?.relations || 0}R in ${formatTime(blobTime)}`);
            }
          }
        };
        
        // Parse the blob with timing
        try {
          data.blob.fastParse(blobEmitter);
        } catch (error) {
          console.error(`[ERROR] Blob parsing failed:`, error);
        }
      }
    });
    
    // Handle completion
    parser.on('end', () => {
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      
      // Calculate aggregate statistics
      const avgBlobTime = blobTimings.length > 0 ? 
        blobTimings.reduce((sum, b) => sum + b.time, 0) / blobTimings.length : 0;
      
      const throughputMBps = totalBytes > 0 ? (totalBytes / 1024 / 1024) / (totalTime / 1000) : 0;
      
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
      
      console.log(`\\n[RESULTS] Mode: ${mode}`);
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
    
    // Track progress to get bytes read
    parser.on('progress', (progressData) => {
      totalBytes = progressData.bytesRead;
    });
    
    // Start parsing
    parser.parse();
  });
}

async function main() {
  console.log('OSM PBF Decode Mode Benchmark (Simplified)');
  console.log('============================');
  console.log(`Test file: ${TEST_FILE}`);
  console.log(`Read threshold: ${READ_THRESHOLD}`);
  console.log(`Decode modes: ${DECODE_MODES.join(', ')}`);
  
  const results = [];
  
  for (const mode of DECODE_MODES) {
    try {
      const result = await benchmarkDecodeMode(mode);
      results.push(result);
    } catch (error) {
      console.error(`Failed to benchmark mode ${mode}:`, error);
    }
  }
  
  // Summary comparison
  console.log('\\n=== DECODE MODE COMPARISON ===');
  console.log('Mode      | Time      | Throughput | Elements  | Avg Blob Time');
  console.log('----------|-----------|------------|-----------|---------------');
  
  for (const result of results) {
    const totalElements = result.totalNodes + result.totalWays + result.totalRelations;
    console.log(`${result.mode.padEnd(9)} | ${formatTime(result.totalTime).padEnd(9)} | ${result.throughputMBps.toFixed(1).padEnd(6)} MB/s | ${totalElements.toString().padEnd(9)} | ${formatTime(result.avgBlobTime)}`);
  }
  
  if (results.length > 1) {
    const fastest = results.reduce((min, r) => r.totalTime < min.totalTime ? r : min, results[0]);
    const slowest = results.reduce((max, r) => r.totalTime > max.totalTime ? r : max, results[0]);
    
    console.log(`\\nFastest: ${fastest.mode} (${formatTime(fastest.totalTime)})`);
    console.log(`Slowest: ${slowest.mode} (${formatTime(slowest.totalTime)})`);
    console.log(`Speed improvement: ${(slowest.totalTime / fastest.totalTime).toFixed(2)}x`);
  }
  
  console.log('\\nBenchmark complete!');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { benchmarkDecodeMode };
