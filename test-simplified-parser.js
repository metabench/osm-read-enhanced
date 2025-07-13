#!/usr/bin/env node

/*
Test Script for Simplified High-Performance OSM PBF Parser
Tests the optimized parser without decode mode overhead
*/

const fs = require('fs');
const zlib = require('zlib');
const OSMBlob = require('./lib/OSM_Blob.js');

console.log('🚀 Testing Simplified High-Performance Parser');
console.log('═'.repeat(50));

const testFile = './test/input/pitcairn-islands-latest.osm.pbf';

if (!fs.existsSync(testFile)) {
  console.error(`❌ Test file not found: ${testFile}`);
  process.exit(1);
}

console.log(`📁 Testing file: ${testFile}`);
console.log(`📊 Size: ${(fs.statSync(testFile).size / 1024).toFixed(1)} KB`);

// Helper functions (copied from benchmark)
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
      
      if (blobs.length >= 10) break; // Limit for testing
    }
  } finally {
    fs.closeSync(fd);
  }
  
  return blobs;
}

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

// Test the parser
async function testParser() {
  let nodeCount = 0, wayCount = 0, relationCount = 0;
  let sampleNode = null, sampleWay = null, sampleRelation = null;
  const startTime = process.hrtime.bigint();

  try {
    const blobs = readBlobHeaders(testFile);
    console.log(`Found ${blobs.length} blobs (${blobs.filter(b => b.type === 'OSMData').length} data blobs)`);
    
    for (const blobData of blobs) {
      if (blobData.type !== 'OSMData') continue; // Skip non-data blobs
      
      try {
        // Decompress blob
        const decompressed = decompressBlob(blobData.buffer);
        
        // Create OSM blob (no decode mode - uses full parsing)
        const blob = new OSMBlob({
          index: blobData.index,
          data: decompressed,
          timing_verbose: false
        });
        
        // Count elements
        let blobNodes = 0;
        let blobWays = 0;
        let blobRelations = 0;
        
        const eventEmitter = {
          emit: (eventType, eventData) => {
            if (eventType === 'node') {
              if (!sampleNode) sampleNode = eventData;
              blobNodes++;
            } else if (eventType === 'way') {
              if (!sampleWay) sampleWay = eventData;
              blobWays++;
            } else if (eventType === 'relation') {
              if (!sampleRelation) sampleRelation = eventData;
              blobRelations++;
            }
          }
        };
        
        // Parse the blob
        blob.fastParse(eventEmitter);
        
        nodeCount += blobNodes;
        wayCount += blobWays;
        relationCount += blobRelations;
        
        console.log(`[BLOB] ${blobData.index}: ${blobNodes}N/${blobWays}W/${blobRelations}R`);
        
      } catch (error) {
        console.error(`[ERROR] Blob ${blobData.index}: ${error.message}`);
      }
    }
    
    const endTime = process.hrtime.bigint();
    const totalTime = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    
    console.log('\n' + '═'.repeat(50));
    console.log('🏁 SIMPLIFIED PARSER TEST COMPLETE');
    console.log('─'.repeat(50));
    console.log(`⏱️  Total time: ${totalTime.toFixed(1)}ms`);
    console.log(`📊 Elements parsed:`);
    console.log(`   📍 Nodes: ${nodeCount.toLocaleString()}`);
    console.log(`   🛣️  Ways: ${wayCount.toLocaleString()}`);
    console.log(`   🔗 Relations: ${relationCount.toLocaleString()}`);
    console.log(`   📁 Total: ${(nodeCount + wayCount + relationCount).toLocaleString()}`);
    
    if (totalTime > 0) {
      const elementsPerSec = (nodeCount + wayCount + relationCount) / (totalTime / 1000);
      console.log(`🚀 Performance: ${elementsPerSec.toFixed(0)} elements/sec`);
    }
    
    // Validate sample elements
    console.log('\n📋 SAMPLE VALIDATION:');
    if (sampleNode) {
      console.log(`✓ Node: ID=${sampleNode.id}, lat=${sampleNode.lat.toFixed(6)}, lon=${sampleNode.lon.toFixed(6)}`);
      console.log(`  Tags: ${Object.keys(sampleNode.tags || {}).length} (${Object.keys(sampleNode.tags || {}).slice(0, 3).join(', ')})`);
    } else {
      console.log('✗ No nodes found');
    }
    
    if (sampleWay) {
      console.log(`✓ Way: ID=${sampleWay.id}, refs=${sampleWay.refs?.length || 0} nodes`);
      console.log(`  Tags: ${Object.keys(sampleWay.tags || {}).length} (${Object.keys(sampleWay.tags || {}).slice(0, 3).join(', ')})`);
    } else {
      console.log('✗ No ways found');
    }
    
    if (sampleRelation) {
      console.log(`✓ Relation: ID=${sampleRelation.id}, members=${sampleRelation.members?.length || 0}`);
      console.log(`  Tags: ${Object.keys(sampleRelation.tags || {}).length} (${Object.keys(sampleRelation.tags || {}).slice(0, 3).join(', ')})`);
    } else {
      console.log('✗ No relations found');
    }
    
    // Expected results for validation
    const expectedNodes = 14214;
    const expectedWays = 471;
    const expectedRelations = 28;
    
    console.log('\n🎯 VALIDATION RESULTS:');
    const nodeMatch = nodeCount === expectedNodes;
    const wayMatch = wayCount === expectedWays;
    const relationMatch = relationCount === expectedRelations;
    
    console.log(`Nodes: ${nodeMatch ? '✓' : '✗'} (got ${nodeCount}, expected ${expectedNodes})`);
    console.log(`Ways: ${wayMatch ? '✓' : '✗'} (got ${wayCount}, expected ${expectedWays})`);
    console.log(`Relations: ${relationMatch ? '✓' : '✗'} (got ${relationCount}, expected ${expectedRelations})`);
    
    if (nodeMatch && wayMatch && relationMatch) {
      console.log('\n🎉 ALL TESTS PASSED! Simplified parser working correctly.');
    } else {
      console.log('\n❌ VALIDATION FAILED! Check parser implementation.');
    }
    
    console.log('═'.repeat(50));
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

testParser();
