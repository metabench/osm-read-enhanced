#!/usr/bin/env node

/**
 * Fast OSM PBF Decode Mode Benchmark 
 * Optimized for minimal timing overhead and accurate performance measurement
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Simple OSM Blob parser for benchmarking
class FastOSMBlob {
  constructor(buffer, options = {}) {
    this.buffer = buffer;
    this.decode_mode = options.decode_mode || 'standard';
    this.timing_verbose = false; // Disable individual timing to reduce overhead
  }

  fastParse(eventEmitter) {
    const start = process.hrtime.bigint();
    
    let nodeCount = 0, wayCount = 0, relationCount = 0;
    
    // Parse primitive groups and count elements based on decode mode
    const data = this.buffer;
    let offset = 0;
    
    // Skip to primitive groups (simplified parsing)
    while (offset < data.length) {
      try {
        const key = data[offset++];
        if (key === 0) break;
        
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (fieldNumber === 2 && wireType === 2) { // PrimitiveGroup
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          
          const endOffset = offset + lenInfo.value;
          const pgData = data.slice(offset, endOffset);
          
          const parsed = this._parsePrimitiveGroup(pgData, eventEmitter);
          nodeCount += parsed.nodes;
          wayCount += parsed.ways;
          relationCount += parsed.relations;
          
          offset = endOffset;
        } else {
          offset = this._skipField(data, offset - 1, wireType);
        }
      } catch (e) {
        break;
      }
    }
    
    const end = process.hrtime.bigint();
    const duration = Number(end - start) / 1000000; // Convert to milliseconds
    
    return {
      nodes: nodeCount,
      ways: wayCount,
      relations: relationCount,
      time: duration
    };
  }
  
  _parsePrimitiveGroup(data, eventEmitter) {
    let nodeCount = 0, wayCount = 0, relationCount = 0;
    let offset = 0;
    
    while (offset < data.length) {
      try {
        const key = data[offset++];
        if (key === 0) break;
        
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (wireType === 2) {
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          
          if (fieldNumber === 2) { // DenseNodes
            const nodeInfo = this._countDenseNodes(data.slice(offset, offset + lenInfo.value));
            nodeCount += nodeInfo.count;
            if (this.decode_mode !== 'minimal' && eventEmitter) {
              for (let i = 0; i < nodeInfo.count; i++) {
                eventEmitter.emit('node', { id: i });
              }
            }
          } else if (fieldNumber === 3) { // Ways
            wayCount++;
            if (this.decode_mode !== 'minimal' && eventEmitter) {
              eventEmitter.emit('way', { id: wayCount });
            }
          } else if (fieldNumber === 4) { // Relations
            relationCount++;
            if (this.decode_mode !== 'minimal' && eventEmitter) {
              eventEmitter.emit('relation', { id: relationCount });
            }
          }
          
          offset += lenInfo.value;
        } else {
          offset = this._skipField(data, offset - 1, wireType);
        }
      } catch (e) {
        break;
      }
    }
    
    return { nodes: nodeCount, ways: wayCount, relations: relationCount };
  }
  
  _countDenseNodes(data) {
    // Quick count of dense nodes by finding ID field
    let count = 0;
    let offset = 0;
    
    while (offset < data.length) {
      try {
        const key = data[offset++];
        if (key === 0) break;
        
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (fieldNumber === 1 && wireType === 2) { // id field (packed)
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          
          // Count varints in the packed field
          const endOffset = offset + lenInfo.value;
          while (offset < endOffset) {
            const varintInfo = this._readVarint(data, offset);
            offset += varintInfo.bytesRead;
            count++;
          }
          return { count };
        } else {
          offset = this._skipField(data, offset - 1, wireType);
        }
      } catch (e) {
        break;
      }
    }
    
    return { count };
  }
  
  _readVarint(data, offset) {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    
    while (offset + bytesRead < data.length && bytesRead < 10) {
      const byte = data[offset + bytesRead];
      value |= (byte & 0x7F) << shift;
      bytesRead++;
      
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }
    
    return { value, bytesRead };
  }
  
  _skipField(data, offset, wireType) {
    const key = data[offset++];
    
    switch (wireType) {
      case 0: // Varint
        while (offset < data.length && (data[offset] & 0x80) !== 0) {
          offset++;
        }
        return offset + 1;
      case 2: // Length-delimited
        const lenInfo = this._readVarint(data, offset);
        return offset + lenInfo.bytesRead + lenInfo.value;
      default:
        return offset + 1;
    }
  }
}

async function benchmarkFile(filePath) {
  console.log('Fast OSM PBF Decode Mode Benchmark');
  console.log('==================================');
  console.log(`Test file: ${filePath}`);
  
  // Read and parse file header
  const buffer = fs.readFileSync(filePath);
  const blobs = [];
  
  let offset = 0;
  while (offset < buffer.length) {
    try {
      // Read header length
      if (offset + 4 > buffer.length) break;
      const headerLen = buffer.readUInt32BE(offset);
      offset += 4;
      
      // Read header
      if (offset + headerLen > buffer.length) break;
      const headerData = buffer.slice(offset, offset + headerLen);
      offset += headerLen;
      
      // Parse header type
      let blobType = null;
      let dataLen = 0;
      let headerOffset = 0;
      
      while (headerOffset < headerData.length) {
        const key = headerData[headerOffset++];
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (fieldNumber === 1 && wireType === 2) { // type
          const lenInfo = readVarint(headerData, headerOffset);
          headerOffset += lenInfo.bytesRead;
          blobType = headerData.slice(headerOffset, headerOffset + lenInfo.value).toString();
          headerOffset += lenInfo.value;
        } else if (fieldNumber === 3 && wireType === 0) { // datasize
          const lenInfo = readVarint(headerData, headerOffset);
          headerOffset += lenInfo.bytesRead;
          dataLen = lenInfo.value;
        } else {
          // Skip field
          if (wireType === 0) {
            while (headerOffset < headerData.length && (headerData[headerOffset] & 0x80) !== 0) {
              headerOffset++;
            }
            headerOffset++;
          } else if (wireType === 2) {
            const lenInfo = readVarint(headerData, headerOffset);
            headerOffset += lenInfo.bytesRead + lenInfo.value;
          }
        }
      }
      
      if (blobType === 'OSMData') {
        // Read blob data
        if (offset + dataLen > buffer.length) break;
        const blobData = buffer.slice(offset, offset + dataLen);
        
        // Decompress if needed
        let decompressed = decompressBlob(blobData);
        if (decompressed) {
          blobs.push(decompressed);
        }
      }
      
      offset += dataLen;
    } catch (e) {
      console.error('Error reading blob:', e.message);
      break;
    }
  }
  
  console.log(`Found ${blobs.length} data blobs`);
  
  // Benchmark different decode modes
  const modes = ['minimal', 'lite', 'standard', 'full'];
  const results = {};
  
  for (const mode of modes) {
    console.log(`\\n=== BENCHMARKING DECODE MODE: ${mode.toUpperCase()} ===`);
    
    const start = process.hrtime.bigint();
    let totalElements = { nodes: 0, ways: 0, relations: 0 };
    let blobTimes = [];
    
    for (let i = 0; i < blobs.length; i++) {
      const blob = new FastOSMBlob(blobs[i], { decode_mode: mode });
      
      const eventEmitter = mode === 'minimal' ? null : {
        emit: () => {} // No-op for performance
      };
      
      const result = blob.fastParse(eventEmitter);
      
      totalElements.nodes += result.nodes;
      totalElements.ways += result.ways;
      totalElements.relations += result.relations;
      blobTimes.push(result.time);
      
      console.log(`[BLOB] ${i + 1}: ${result.nodes}N/${result.ways}W/${result.relations}R in ${result.time.toFixed(1)}ms`);
    }
    
    const end = process.hrtime.bigint();
    const totalTime = Number(end - start) / 1000000;
    const avgBlobTime = blobTimes.reduce((a, b) => a + b, 0) / blobTimes.length;
    const totalCount = totalElements.nodes + totalElements.ways + totalElements.relations;
    
    results[mode] = {
      time: totalTime,
      elements: totalCount,
      avgBlobTime,
      elementsPerSec: Math.round(totalCount / (totalTime / 1000)),
      breakdown: totalElements
    };
    
    console.log(`\\n[RESULTS] Mode: ${mode}`);
    console.log(`  Total time: ${totalTime.toFixed(1)}ms`);
    console.log(`  Blobs processed: ${blobs.length}`);
    console.log(`  Elements: ${totalElements.nodes}N + ${totalElements.ways}W + ${totalElements.relations}R = ${totalCount}`);
    console.log(`  Avg blob time: ${avgBlobTime.toFixed(1)}ms`);
    console.log(`  Elements/sec: ${results[mode].elementsPerSec}`);
  }
  
  // Summary comparison
  console.log('\\n=== DECODE MODE COMPARISON ===');
  console.log('Mode      | Time      | Elements  | Avg Blob Time | Elements/sec');
  console.log('----------|-----------|-----------|---------------|-------------');
  
  for (const mode of modes) {
    const r = results[mode];
    console.log(`${mode.padEnd(9)} | ${r.time.toFixed(1).padStart(8)}ms | ${r.elements.toString().padStart(8)} | ${r.avgBlobTime.toFixed(1).padStart(12)}ms | ${r.elementsPerSec.toString().padStart(11)}`);
  }
  
  // Find fastest and slowest
  const times = modes.map(mode => ({ mode, time: results[mode].time }));
  times.sort((a, b) => a.time - b.time);
  
  console.log(`\\nFastest: ${times[0].mode} (${times[0].time.toFixed(1)}ms)`);
  console.log(`Slowest: ${times[times.length - 1].mode} (${times[times.length - 1].time.toFixed(1)}ms)`);
  console.log(`Speed improvement: ${(times[times.length - 1].time / times[0].time).toFixed(2)}x`);
  
  console.log('\\nBenchmark complete!');
}

function readVarint(data, offset) {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < data.length && bytesRead < 10) {
    const byte = data[offset + bytesRead];
    value |= (byte & 0x7F) << shift;
    bytesRead++;
    
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  
  return { value, bytesRead };
}

function decompressBlob(blobData) {
  try {
    let offset = 0;
    let rawData = null;
    let zlibData = null;
    
    while (offset < blobData.length) {
      const key = blobData[offset++];
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) { // raw
        const lenInfo = readVarint(blobData, offset);
        offset += lenInfo.bytesRead;
        rawData = blobData.slice(offset, offset + lenInfo.value);
        return rawData;
      } else if (fieldNumber === 3 && wireType === 2) { // zlib_data
        const lenInfo = readVarint(blobData, offset);
        offset += lenInfo.bytesRead;
        zlibData = blobData.slice(offset, offset + lenInfo.value);
        offset += lenInfo.value;
      } else {
        // Skip field
        if (wireType === 0) {
          while (offset < blobData.length && (blobData[offset] & 0x80) !== 0) {
            offset++;
          }
          offset++;
        } else if (wireType === 2) {
          const lenInfo = readVarint(blobData, offset);
          offset += lenInfo.bytesRead + lenInfo.value;
        }
      }
    }
    
    if (zlibData) {
      return zlib.inflateSync(zlibData);
    }
  } catch (e) {
    console.error('Decompression error:', e.message);
  }
  
  return null;
}

// Run the benchmark
const testFile = './test/input/pitcairn-islands-latest.osm.pbf';
if (fs.existsSync(testFile)) {
  benchmarkFile(testFile).catch(console.error);
} else {
  console.error(`Test file not found: ${testFile}`);
  process.exit(1);
}
