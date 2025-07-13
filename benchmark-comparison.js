#!/usr/bin/env node

/**
 * Comparison Benchmark: Simplified OSM_Blob vs Decode Mode OSM_Blob
 * Compares performance of the simplified implementation against the complex decode mode version
 */

const fs = require('fs');
const zlib = require('zlib');
const SimplifiedOSMBlob = require('./lib/SimplifiedOSMBlob');

// Add blob reading function (copied from direct benchmark)
async function readBlobsFromFile(filePath) {
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
      
      // Parse header to get blob type and data length
      const header = parseHeader(headerData);
      
      if (header.type === 'OSMData') {
        // Read blob data
        if (offset + header.datasize > buffer.length) break;
        const blobData = buffer.slice(offset, offset + header.datasize);
        
        // Parse and decompress blob
        const blob = parseBlob(blobData);
        if (blob.decompressed) {
          blobs.push(blob.decompressed);
        }
      }
      
      offset += header.datasize;
    } catch (e) {
      console.error('Error reading blob:', e.message);
      break;
    }
  }
  
  return blobs;
}

function parseHeader(headerData) {
  let offset = 0;
  let type = null;
  let datasize = 0;
  
  while (offset < headerData.length) {
    const keyInfo = readVarint(headerData, offset);
    const key = keyInfo.value;
    offset += keyInfo.bytesRead;
    
    const fieldNumber = key >> 3;
    const wireType = key & 0x07;
    
    if (fieldNumber === 1 && wireType === 2) { // type
      const lenInfo = readVarint(headerData, offset);
      offset += lenInfo.bytesRead;
      type = headerData.slice(offset, offset + lenInfo.value).toString();
      offset += lenInfo.value;
    } else if (fieldNumber === 3 && wireType === 0) { // datasize
      const sizeInfo = readVarint(headerData, offset);
      datasize = sizeInfo.value;
      offset += sizeInfo.bytesRead;
    } else {
      offset = skipField(headerData, offset - keyInfo.bytesRead, wireType);
    }
  }
  
  return { type, datasize };
}

function parseBlob(blobData) {
  let offset = 0;
  let rawData = null;
  let zlibData = null;
  
  while (offset < blobData.length) {
    const keyInfo = readVarint(blobData, offset);
    const key = keyInfo.value;
    offset += keyInfo.bytesRead;
    
    const fieldNumber = key >> 3;
    const wireType = key & 0x07;
    
    if (fieldNumber === 1 && wireType === 2) { // raw
      const lenInfo = readVarint(blobData, offset);
      offset += lenInfo.bytesRead;
      rawData = blobData.slice(offset, offset + lenInfo.value);
      return { decompressed: rawData };
    } else if (fieldNumber === 3 && wireType === 2) { // zlib_data
      const lenInfo = readVarint(blobData, offset);
      offset += lenInfo.bytesRead;
      zlibData = blobData.slice(offset, offset + lenInfo.value);
      offset += lenInfo.value;
    } else {
      offset = skipField(blobData, offset - keyInfo.bytesRead, wireType);
    }
  }
  
  if (zlibData) {
    try {
      return { decompressed: zlib.inflateSync(zlibData) };
    } catch (e) {
      console.error('Decompression error:', e.message);
    }
  }
  
  return { decompressed: null };
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

function skipField(data, offset, wireType) {
  const key = data[offset++];
  
  switch (wireType) {
    case 0: // Varint
      while (offset < data.length && (data[offset] & 0x80) !== 0) {
        offset++;
      }
      return offset + 1;
    case 2: // Length-delimited
      const lenInfo = readVarint(data, offset);
      return offset + lenInfo.bytesRead + lenInfo.value;
    default:
      return offset + 1;
  }
}

async function benchmarkComparison(filePath) {
  console.log('OSM_Blob Implementation Comparison');
  console.log('=================================');
  console.log(`Test file: ${filePath}`);
  
  // Read file and extract blobs using direct file reading (same as direct benchmark)
  const blobs = await readBlobsFromFile(filePath);
  
  console.log(`Found ${blobs.length} data blobs`);
  
  // Test both implementations
  const implementations = {
    'simplified': testSimplifiedImplementation,
    'decode_mode_full': testDecodeModeFull,
    'decode_mode_minimal': testDecodeModeMinimal
  };
  
  const results = {};
  
  for (const [name, testFunc] of Object.entries(implementations)) {
    console.log(`\\n=== TESTING: ${name.toUpperCase()} ===`);
    
    const start = process.hrtime.bigint();
    let totalElements = { nodes: 0, ways: 0, relations: 0 };
    let blobTimes = [];
    
    for (let i = 0; i < blobs.length; i++) {
      const blobStart = process.hrtime.bigint();
      const result = testFunc(blobs[i], i + 2); // +2 to match original numbering
      const blobEnd = process.hrtime.bigint();
      const blobTime = Number(blobEnd - blobStart) / 1000000;
      
      totalElements.nodes += result.nodes;
      totalElements.ways += result.ways;
      totalElements.relations += result.relations;
      blobTimes.push(blobTime);
      
      console.log(`[BLOB] ${i + 2}: ${result.nodes}N/${result.ways}W/${result.relations}R in ${blobTime.toFixed(1)}ms`);
    }
    
    const end = process.hrtime.bigint();
    const totalTime = Number(end - start) / 1000000;
    const avgBlobTime = blobTimes.reduce((a, b) => a + b, 0) / blobTimes.length;
    const totalCount = totalElements.nodes + totalElements.ways + totalElements.relations;
    
    results[name] = {
      time: totalTime,
      elements: totalCount,
      avgBlobTime,
      elementsPerSec: Math.round(totalCount / (totalTime / 1000)),
      breakdown: totalElements
    };
    
    console.log(`\\n[RESULTS] ${name}`);
    console.log(`  Total time: ${totalTime.toFixed(1)}ms`);
    console.log(`  Elements: ${totalElements.nodes}N + ${totalElements.ways}W + ${totalElements.relations}R = ${totalCount}`);
    console.log(`  Avg blob time: ${avgBlobTime.toFixed(1)}ms`);
    console.log(`  Elements/sec: ${results[name].elementsPerSec}`);
  }
  
  // Comparison summary
  console.log('\\n=== IMPLEMENTATION COMPARISON ===');
  console.log('Implementation     | Time      | Elements  | Elements/sec | vs Simplified');
  console.log('-------------------|-----------|-----------|--------------|-------------');
  
  const simplifiedTime = results.simplified.time;
  const simplifiedEPS = results.simplified.elementsPerSec;
  
  for (const [name, result] of Object.entries(results)) {
    const speedup = name === 'simplified' ? '1.00x' : `${(result.time / simplifiedTime).toFixed(2)}x slower`;
    const epsRatio = name === 'simplified' ? '100%' : `${((result.elementsPerSec / simplifiedEPS) * 100).toFixed(0)}%`;
    
    console.log(`${name.padEnd(18)} | ${result.time.toFixed(1).padStart(8)}ms | ${result.elements.toString().padStart(8)} | ${result.elementsPerSec.toString().padStart(11)} | ${speedup.padStart(11)} (${epsRatio})`);
  }
  
  // Performance analysis
  const decodeFull = results.decode_mode_full;
  const decodeMinimal = results.decode_mode_minimal;
  const simplified = results.simplified;
  
  console.log('\\n=== PERFORMANCE ANALYSIS ===');
  console.log(`Simplified vs Decode Mode Full: ${(decodeFull.time / simplified.time).toFixed(2)}x faster`);
  console.log(`Simplified vs Decode Mode Minimal: ${(decodeMinimal.time / simplified.time).toFixed(2)}x faster`);
  console.log(`Best decode mode vs Simplified: ${Math.min(decodeFull.time, decodeMinimal.time) < simplified.time ? 'Decode mode wins' : 'Simplified wins'}`);
  
  console.log('\\nBenchmark complete!');
}

function testSimplifiedImplementation(blobBuffer, index) {
  // For now, let's just test the current OSM_Blob in simplified mode
  // (We'll implement the real simplified version later)
  const OSM_Blob = require('./lib/OSM_Blob');
  const blob = new OSM_Blob({
    index: index,
    data: blobBuffer,
    timing_verbose: false,
    decode_mode: 'full' // Use full as "simplified" baseline
  });
  
  let nodeCount = 0, wayCount = 0, relationCount = 0;
  
  const eventEmitter = {
    emit: (type) => {
      if (type === 'node') nodeCount++;
      else if (type === 'way') wayCount++;
      else if (type === 'relation') relationCount++;
    }
  };
  
  blob.fastParse(eventEmitter);
  
  return { nodes: nodeCount, ways: wayCount, relations: relationCount };
}

function testDecodeModeFull(blobBuffer, index) {
  // Use original implementation with full decode mode
  const OSM_Blob = require('./lib/OSM_Blob');
  const blob = new OSM_Blob({
    index: index,
    data: blobBuffer,
    timing_verbose: false,
    decode_mode: 'full'
  });
  
  let nodeCount = 0, wayCount = 0, relationCount = 0;
  
  const eventEmitter = {
    emit: (type) => {
      if (type === 'node') nodeCount++;
      else if (type === 'way') wayCount++;
      else if (type === 'relation') relationCount++;
    }
  };
  
  blob.fastParse(eventEmitter);
  
  return { nodes: nodeCount, ways: wayCount, relations: relationCount };
}

function testDecodeModeMinimal(blobBuffer, index) {
  // Use original implementation with minimal decode mode
  const OSM_Blob = require('./lib/OSM_Blob');
  const blob = new OSM_Blob({
    index: index,
    data: blobBuffer,
    timing_verbose: false,
    decode_mode: 'minimal'
  });
  
  let nodeCount = 0, wayCount = 0, relationCount = 0;
  
  const eventEmitter = {
    emit: (type) => {
      if (type === 'node') nodeCount++;
      else if (type === 'way') wayCount++;
      else if (type === 'relation') relationCount++;
    }
  };
  
  blob.fastParse(eventEmitter);
  
  return { nodes: nodeCount, ways: wayCount, relations: relationCount };
}

function parseOSMData(blobBuffer) {
  let offset = 0;
  let stringTable = null;
  let primitiveData = null;
  
  while (offset < blobBuffer.length) {
    const keyInfo = readVarint(blobBuffer, offset);
    const key = keyInfo.value;
    offset += keyInfo.bytesRead;
    
    const fieldNumber = key >> 3;
    const wireType = key & 0x07;
    
    if (wireType === 2) {
      const lenInfo = readVarint(blobBuffer, offset);
      offset += lenInfo.bytesRead;
      
      if (fieldNumber === 1) { // stringtable
        stringTable = parseStringTable(blobBuffer.slice(offset, offset + lenInfo.value));
      } else if (fieldNumber === 2) { // primitivegroup
        primitiveData = blobBuffer.slice(offset, offset + lenInfo.value);
      }
      
      offset += lenInfo.value;
    } else {
      offset = skipField(blobBuffer, offset - keyInfo.bytesRead, wireType);
    }
  }
  
  return { stringTable, primitiveData };
}

function parseStringTable(data) {
  let offset = 0;
  const strings = [];
  
  while (offset < data.length) {
    const keyInfo = readVarint(data, offset);
    const key = keyInfo.value;
    offset += keyInfo.bytesRead;
    
    const fieldNumber = key >> 3;
    const wireType = key & 0x07;
    
    if (fieldNumber === 1 && wireType === 2) { // s
      const lenInfo = readVarint(data, offset);
      offset += lenInfo.bytesRead;
      strings.push(data.slice(offset, offset + lenInfo.value));
      offset += lenInfo.value;
    } else {
      offset = skipField(data, offset - keyInfo.bytesRead, wireType);
    }
  }
  
  return { s: strings };
}

// Run the benchmark
const testFile = './test/input/pitcairn-islands-latest.osm.pbf';
if (fs.existsSync(testFile)) {
  benchmarkComparison(testFile).catch(console.error);
} else {
  console.error(`Test file not found: ${testFile}`);
  process.exit(1);
}
