#!/usr/bin/env node

const fs = require('fs');
const { performance } = require('perf_hooks');
const OSMBlob = require('./lib/OSM_Blob.js');
const zlib = require('zlib');

// Configuration
const TEST_FILE = './test/input/pitcairn-islands-latest.osm.pbf';
const DECODE_MODES = ['minimal', 'lite', 'standard', 'full'];

// Simple blob decompression function
function decompressBlob(blobBuffer) {
  const blob = {};
  let offset = 0;
  
  // Parse blob protobuf message
  while (offset < blobBuffer.length) {
    const keyInfo = readVarint(blobBuffer, offset);
    const key = keyInfo.value;
    offset += keyInfo.bytesRead;
    
    const fieldNumber = key >> 3;
    const wireType = key & 0x07;
    
    if (wireType === 2) { // Length-delimited (bytes)
      const lenInfo = readVarint(blobBuffer, offset);
      const dataLength = lenInfo.value;
      offset += lenInfo.bytesRead;
      
      const data = blobBuffer.slice(offset, offset + dataLength);
      offset += dataLength;
      
      switch (fieldNumber) {
        case 1: // raw
          blob.raw = data;
          break;
        case 3: // zlib_data
          blob.zlib_data = data;
          break;
        case 5: // raw_size
          // This should be varint, not length-delimited, but let's handle it
          break;
      }
    } else if (wireType === 0) { // Varint
      const valueInfo = readVarint(blobBuffer, offset);
      offset += valueInfo.bytesRead;
      
      if (fieldNumber === 5) { // raw_size
        blob.raw_size = valueInfo.value;
      }
    } else {
      // Skip unknown field types
      break;
    }
  }
  
  // Decompress if needed
  if (blob.raw) {
    return blob.raw;
  } else if (blob.zlib_data) {
    return zlib.inflateSync(blob.zlib_data);
  } else {
    throw new Error('No decompressible data found in blob');
  }
}

// Helper function to read varint
function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead];
    value |= (byte & 0x7F) << shift;
    bytesRead++;
    
    if ((byte & 0x80) === 0) {
      break;
    }
    
    shift += 7;
    if (shift >= 64) {
      throw new Error('Varint too long');
    }
  }
  
  return { value, bytesRead };
}

// Helper function to format time
function formatTime(ms) {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Read and parse PBF file header to find blobs
function readBlobHeaders(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const blobs = [];
  let offset = 0;
  
  try {
    while (true) {
      // Read blob header length (4 bytes)
      const lengthBuffer = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, lengthBuffer, 0, 4, offset);
      if (bytesRead === 0) break;
      
      const headerLength = lengthBuffer.readInt32BE(0);
      if (headerLength <= 0 || headerLength > 64 * 1024) break;
      
      // Read blob header
      const headerBuffer = Buffer.alloc(headerLength);
      fs.readSync(fd, headerBuffer, 0, headerLength, offset + 4);
      
      // Parse header to get blob size
      const header = parseFileBlockHeader(headerBuffer);
      if (!header || !header.datasize) break;
      
      // Read blob data
      const blobOffset = offset + 4 + headerLength;
      const blobBuffer = Buffer.alloc(header.datasize);
      fs.readSync(fd, blobBuffer, 0, header.datasize, blobOffset);
      
      blobs.push({
        type: header.type,
        buffer: blobBuffer,
        index: blobs.length + 1
      });
      
      offset = blobOffset + header.datasize;
    }
  } finally {
    fs.closeSync(fd);
  }
  
  return blobs;
}

// Simple protobuf parser for file block header
function parseFileBlockHeader(buffer) {
  let offset = 0;
  const result = {};
  
  while (offset < buffer.length) {
    const tag = buffer[offset++];
    const field = tag >> 3;
    const wireType = tag & 0x07;
    
    if (wireType === 2) { // String
      const length = buffer[offset++];
      const value = buffer.slice(offset, offset + length).toString();
      offset += length;
      
      if (field === 1) result.type = value;
    } else if (wireType === 0) { // Varint
      let value = 0;
      let shift = 0;
      
      while (offset < buffer.length) {
        const byte = buffer[offset++];
        value |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      
      if (field === 3) result.datasize = value;
    } else {
      // Skip unknown fields
      break;
    }
  }
  
  return result;
}

async function benchmarkDecodeMode(mode, blobs) {
  console.log(`\\n=== BENCHMARKING DECODE MODE: ${mode.toUpperCase()} ===`);
  
  const startTime = performance.now();
  let totalNodes = 0;
  let totalWays = 0;
  let totalRelations = 0;
  let blobTimings = [];
  
  for (const blobData of blobs) {
    if (blobData.type !== 'OSMData') continue; // Skip non-data blobs
    
    const blobStartTime = performance.now();
    
    try {
      // Decompress blob
      const decompressed = decompressBlob(blobData.buffer);
      
      // Create OSM blob with timing enabled
      const blob = new OSMBlob({
        index: blobData.index,
        data: decompressed,
        timing_verbose: false, // Disable verbosity for clean benchmark
        decode_mode: mode
      });
      
      // Count elements
      let blobNodes = 0;
      let blobWays = 0;
      let blobRelations = 0;
      
      const eventEmitter = {
        emit: (eventType, eventData) => {
          if (eventType === 'node') {
            blobNodes++;
          } else if (eventType === 'way') {
            blobWays++;
          } else if (eventType === 'relation') {
            blobRelations++;
          } else if (eventType === 'blob_complete') {
            // Use counts from blob completion if available
            if (eventData.counts) {
              blobNodes = eventData.counts.nodes;
              blobWays = eventData.counts.ways;
              blobRelations = eventData.counts.relations;
            }
          }
        }
      };
      
      // Parse the blob
      blob.fastParse(eventEmitter);
      
      const blobEndTime = performance.now();
      const blobTime = blobEndTime - blobStartTime;
      
      totalNodes += blobNodes;
      totalWays += blobWays;
      totalRelations += blobRelations;
      
      blobTimings.push({
        index: blobData.index,
        time: blobTime,
        nodes: blobNodes,
        ways: blobWays,
        relations: blobRelations
      });
      
      console.log(`[BLOB] ${blobData.index}: ${blobNodes}N/${blobWays}W/${blobRelations}R in ${formatTime(blobTime)}`);
      
    } catch (error) {
      console.error(`[ERROR] Blob ${blobData.index}: ${error.message}`);
    }
  }
  
  const endTime = performance.now();
  const totalTime = endTime - startTime;
  
  const avgBlobTime = blobTimings.length > 0 ? 
    blobTimings.reduce((sum, b) => sum + b.time, 0) / blobTimings.length : 0;
  
  const results = {
    mode: mode,
    totalTime: totalTime,
    blobCount: blobTimings.length,
    totalNodes: totalNodes,
    totalWays: totalWays,
    totalRelations: totalRelations,
    avgBlobTime: avgBlobTime,
    blobTimings: blobTimings
  };
  
  console.log(`\\n[RESULTS] Mode: ${mode}`);
  console.log(`  Total time: ${formatTime(totalTime)}`);
  console.log(`  Blobs processed: ${blobTimings.length}`);
  console.log(`  Elements: ${totalNodes}N + ${totalWays}W + ${totalRelations}R = ${totalNodes + totalWays + totalRelations}`);
  console.log(`  Avg blob time: ${formatTime(avgBlobTime)}`);
  
  return results;
}

async function main() {
  console.log('OSM PBF Decode Mode Direct Benchmark');
  console.log('====================================');
  console.log(`Test file: ${TEST_FILE}`);
  
  // Read all blobs from file
  console.log('Reading blobs from file...');
  const blobs = readBlobHeaders(TEST_FILE);
  const dataBlobs = blobs.filter(b => b.type === 'OSMData');
  console.log(`Found ${dataBlobs.length} data blobs`);
  
  const results = [];
  
  for (const mode of DECODE_MODES) {
    try {
      const result = await benchmarkDecodeMode(mode, dataBlobs);
      results.push(result);
    } catch (error) {
      console.error(`Failed to benchmark mode ${mode}:`, error);
    }
  }
  
  // Summary comparison
  console.log('\\n=== DECODE MODE COMPARISON ===');
  console.log('Mode      | Time      | Elements  | Avg Blob Time | Elements/sec');
  console.log('----------|-----------|-----------|---------------|-------------');
  
  for (const result of results) {
    const totalElements = result.totalNodes + result.totalWays + result.totalRelations;
    const elementsPerSec = totalElements / (result.totalTime / 1000);
    console.log(`${result.mode.padEnd(9)} | ${formatTime(result.totalTime).padEnd(9)} | ${totalElements.toString().padEnd(9)} | ${formatTime(result.avgBlobTime).padEnd(13)} | ${elementsPerSec.toFixed(0)}`);
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
