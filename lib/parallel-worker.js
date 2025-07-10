/**
 * Worker thread for parallel OSM PBF processing
 * This file is used by parallel-processor.js to distribute work across CPU cores
 */

const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const zlib = require('zlib');
const proto = require('./proto/index.js');

// Get worker parameters
const { id, filePath, startOffset, endOffset, highWaterMark } = workerData;

// Reporting functions
function sendMessage(type, data) {
  parentPort.postMessage({ type, data });
}

function sendProgress(bytesProcessed) {
  sendMessage('progress', { bytesProcessed });
}

function sendError(error) {
  sendMessage('error', { 
    message: error.message, 
    stack: error.stack 
  });
}

// Process function
async function processSegment() {
  try {
    sendMessage('progress', { status: 'starting', offset: startOffset });
    
    let bytesProcessed = 0;
    let position = startOffset;
    
    // Open file for reading
    const fd = await fs.promises.open(filePath, 'r');
    
    // Continue until we reach the end offset
    while (position < endOffset) {
      try {
        // Read blob header size (4 bytes)
        const headerSizeBuffer = Buffer.alloc(4);
        const { bytesRead: headerSizeBytesRead } = await fd.read(headerSizeBuffer, 0, 4, position);
        
        if (headerSizeBytesRead < 4) {
          // End of file reached
          break;
        }
        
        position += 4;
        bytesProcessed += 4;
        
        // Read header size
        const headerSize = headerSizeBuffer.readUInt32BE(0);
        
        // Read header content
        const headerBuffer = Buffer.alloc(headerSize);
        const { bytesRead: headerBytesRead } = await fd.read(headerBuffer, 0, headerSize, position);
        
        if (headerBytesRead < headerSize) {
          break;
        }
        
        position += headerSize;
        bytesProcessed += headerSize;
        
        // Parse header to get blob type and size
        const headerInfo = parseHeader(headerBuffer);
        
        // Read blob data
        const blobBuffer = Buffer.alloc(headerInfo.datasize);
        const { bytesRead: blobBytesRead } = await fd.read(blobBuffer, 0, headerInfo.datasize, position);
        
        if (blobBytesRead < headerInfo.datasize) {
          break;
        }
        
        position += headerInfo.datasize;
        bytesProcessed += headerInfo.datasize;
        
        // Update progress
        if (bytesProcessed % (1024 * 1024) === 0) {
          sendProgress(bytesProcessed);
        }
        
        // Process blob data based on type
        if (headerInfo.type === 'OSMData') {
          await processOSMDataBlob(blobBuffer);
        }
        
        // Stop if we've gone beyond our assigned segment
        if (position >= endOffset) {
          break;
        }
      } catch (err) {
        sendError(err);
        // Try to continue with next blob
        position += highWaterMark;
      }
    }
    
    await fd.close();
    
    // Send final progress
    sendProgress(bytesProcessed);
    sendMessage('complete', { bytesProcessed });
    
  } catch (error) {
    sendError(error);
  }
}

// Parse header information from buffer
function parseHeader(buffer) {
  let offset = 0;
  const result = { type: null, datasize: null };
  
  while (offset < buffer.length) {
    const keyInfo = parseVarint(buffer, offset);
    offset += keyInfo.bytesRead;
    
    const fieldNumber = keyInfo.value >> 3;
    const wireType = keyInfo.value & 0x07;
    
    if (fieldNumber === 1 && wireType === 2) {
      // Type (string)
      const lenInfo = parseVarint(buffer, offset);
      offset += lenInfo.bytesRead;
      
      result.type = buffer.toString('utf8', offset, offset + lenInfo.value);
      offset += lenInfo.value;
    } else if (fieldNumber === 2 && wireType === 0) {
      // Datasize (varint)
      const sizeInfo = parseVarint(buffer, offset);
      offset += sizeInfo.bytesRead;
      result.datasize = sizeInfo.value;
    } else {
      // Skip unknown field
      if (wireType === 0) {
        const skipInfo = parseVarint(buffer, offset);
        offset += skipInfo.bytesRead;
      } else if (wireType === 1) {
        offset += 8; // 64-bit
      } else if (wireType === 2) {
        const lenInfo = parseVarint(buffer, offset);
        offset += lenInfo.bytesRead + lenInfo.value;
      } else if (wireType === 5) {
        offset += 4; // 32-bit
      } else {
        throw new Error(`Unknown wire type: ${wireType}`);
      }
    }
  }
  
  return result;
}

// Parse varint from buffer
function parseVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (true) {
    if (offset + bytesRead >= buffer.length) {
      throw new Error("Buffer ended while reading varint");
    }
    
    const byte = buffer[offset + bytesRead++];
    result |= (byte & 0x7F) << shift;
    
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  
  return { value: result, bytesRead };
}

// Process an OSMData blob
async function processOSMDataBlob(blobBuffer) {
  // Decompress blob
  const blob = proto.OSMPBF.Blob.decode(blobBuffer);
  
  let decompressedData;
  if (blob.zlib_data) {
    decompressedData = await new Promise((resolve, reject) => {
      zlib.inflate(blob.zlib_data, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  } else if (blob.raw) {
    decompressedData = blob.raw;
  } else {
    throw new Error("Unsupported compression format");
  }
  
  // Decode as PrimitiveBlock
  const primBlock = proto.OSMPBF.PrimitiveBlock.decode(decompressedData);
  
  // Process primitive groups
  for (const primGroup of primBlock.primitivegroup) {
    // Process dense nodes
    if (primGroup.dense) {
      await processDenseNodes(primBlock, primGroup);
    }
    
    // Process ways
    if (primGroup.ways && primGroup.ways.length > 0) {
      await processWays(primBlock, primGroup);
    }
    
    // Process relations
    if (primGroup.relations && primGroup.relations.length > 0) {
      await processRelations(primBlock, primGroup);
    }
  }
}

// Process dense nodes
async function processDenseNodes(block, pg) {
  if (!pg.dense || !pg.dense.id || pg.dense.id.length === 0) return;
  
  const stringtable = block.stringtable.s;
  const nodesCount = pg.dense.id.length;
  
  let id = 0, lat = 0, lon = 0;
  let tagIndex = 0;
  
  for (let i = 0; i < nodesCount; i++) {
    // Delta decode
    id += Number(pg.dense.id[i]);
    lat += Number(pg.dense.lat[i]);
    lon += Number(pg.dense.lon[i]);
    
    // Convert lat/lon
    const latitude = (Number(block.latOffset) + (block.granularity * lat)) / 1000000000;
    const longitude = (Number(block.lonOffset) + (block.granularity * lon)) / 1000000000;
    
    // Extract tags
    const tags = {};
    if (pg.dense.keysVals) {
      while (tagIndex < pg.dense.keysVals.length) {
        const keyId = pg.dense.keysVals[tagIndex++];
        if (keyId === 0) break;
        
        const valId = pg.dense.keysVals[tagIndex++];
        const key = stringtable[keyId].toString('utf8');
        const val = stringtable[valId].toString('utf8');
        tags[key] = val;
      }
    }
    
    // Send node to main thread
    sendMessage('node', { id, lat: latitude, lon: longitude, tags });
    
    // Allow other operations to happen
    if (i % 1000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

// Process ways
async function processWays(block, pg) {
  if (!pg.ways) return;
  
  const stringtable = block.stringtable.s;
  
  for (let i = 0; i < pg.ways.length; i++) {
    const way = pg.ways[i];
    
    // Extract way ID
    const id = Number(way.id);
    
    // Extract tags
    const tags = {};
    if (way.keys && way.vals) {
      for (let t = 0; t < way.keys.length; t++) {
        const key = stringtable[way.keys[t]].toString('utf8');
        const val = stringtable[way.vals[t]].toString('utf8');
        tags[key] = val;
      }
    }
    
    // Extract node refs (delta encoded)
    const nodeRefs = [];
    let nodeId = 0;
    if (way.refs) {
      for (let r = 0; r < way.refs.length; r++) {
        nodeId += Number(way.refs[r]);
        nodeRefs.push(nodeId);
      }
    }
    
    // Send way to main thread
    sendMessage('way', { id, tags, nodeRefs });
    
    // Allow other operations to happen
    if (i % 100 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

// Process relations
async function processRelations(block, pg) {
  if (!pg.relations) return;
  
  const stringtable = block.stringtable.s;
  
  for (let i = 0; i < pg.relations.length; i++) {
    const relation = pg.relations[i];
    
    // Extract relation ID
    const id = Number(relation.id);
    
    // Extract tags
    const tags = {};
    if (relation.keys && relation.vals) {
      for (let t = 0; t < relation.keys.length; t++) {
        const key = stringtable[relation.keys[t]].toString('utf8');
        const val = stringtable[relation.vals[t]].toString('utf8');
        tags[key] = val;
      }
    }
    
    // Extract members (delta encoded)
    const members = [];
    let memberId = 0;
    
    if (relation.memids && relation.types && relation.rolesSid) {
      for (let m = 0; m < relation.memids.length; m++) {
        memberId += Number(relation.memids[m]);
        
        let type;
        switch (relation.types[m]) {
          case 0: type = 'node'; break;
          case 1: type = 'way'; break;
          case 2: type = 'relation'; break;
          default: type = 'unknown';
        }
        
        const role = stringtable[relation.rolesSid[m]].toString('utf8');
        
        members.push({ ref: memberId, type, role });
      }
    }
    
    // Send relation to main thread
    sendMessage('relation', { id, tags, members });
    
    // Allow other operations to happen
    if (i % 10 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

// Start processing
processSegment().catch(err => {
  sendError(err);
});
