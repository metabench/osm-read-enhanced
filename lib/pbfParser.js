/*
 * The following little overview extends the osm pbf file structure description
 * from http://wiki.openstreetmap.org/wiki/PBF_Format:
 *
 * - [1] file
 *   - [n] file blocks
 *     - [1] blob header
 *     - [1] blob
 */

var protobuf = require('protobufjs/minimal');
var proto = require('./proto/index.js');
var buf = require('./buffer.js');

var zlib, reader, arrayBufferReader, fileReader;

// check if running in Browser or Node.js (use self not window because of Web Workers)
if (typeof self !== 'undefined') {
    zlib = require('./browser/zlib.js');
    arrayBufferReader = require('./browser/arrayBufferReader.js');
    fileReader = require('./browser/fileReader.js');
} else {
    zlib = require('./nodejs/zlib.js');
    reader = require('./nodejs/fsReader.js');
}

const Long = protobuf.util.Long;

// Wrap verbose logging: if opts.verbose is true the events below are logged.
function logVerbose(message, details) {
  console.log(`[VERBOSE] ${message}`, details || '');
}

function parse(opts){
    // Ensure a found callback exists.
    if (typeof opts.found !== 'function') {
      opts.found = function(item) {
        //console.log("found", item);
      };
    }
    var paused, resumeCallback, documentEndReached;
    // New progress tracking variables:
    var bytesRead = 0,
        startTime = Date.now(),
        lastIntervalBytes = 0,
        progressInterval = setInterval(() => {
          const now = Date.now(),
                mbLastSec = ((bytesRead - lastIntervalBytes) / (1024 * 1024)).toFixed(2);
          lastIntervalBytes = bytesRead;
          console.log(`Progress: ${mbLastSec} MB/s, total read: ${(bytesRead / (1024 * 1024)).toFixed(2)} MB`);
        }, 1000);

    if(opts.verbose){
      console.log("Starting pbf parsing. Opening file:", opts.filePath);
    }
    documentEndReached = false;
    paused = false;
    resumeCallback = null;

    createPathParser({
        filePath: opts.filePath,
        buffer: opts.buffer,
        file: opts.file,
        callback: function(err, parser){
            if(err){
              clearInterval(progressInterval);
              return opts.callback(err);
            }
            if(opts.verbose){
              logVerbose("File opened successfully. Number of file blocks found:", parser.fileBlocks.length);
            }
            var nextFileBlockIndex = 0;
            var concurrentBlocks = 0;
            
            // Dynamic concurrent block limit based on worker pool capacity and memory
            function calculateOptimalConcurrency() {
                const workerStats = require('./nodejs/zlib').getWorkerPoolStats();
                const memPressure = workerStats.memoryPressure || 0;
                
                // Base concurrency on available workers and memory pressure - increased for more workers
                let baseConcurrency = Math.min(12, workerStats.totalWorkers + 4); // Increased from 6 to 12
                
                // Reduce concurrency under memory pressure
                if (memPressure > 80) {
                    baseConcurrency = Math.max(3, Math.floor(baseConcurrency * 0.5)); // Increased min from 2 to 3
                } else if (memPressure > 60) {
                    baseConcurrency = Math.max(6, Math.floor(baseConcurrency * 0.75)); // Increased min from 3 to 6
                }
                
                return baseConcurrency;
            }
            
            var maxConcurrentBlocks = calculateOptimalConcurrency();
            
            // Periodically adjust concurrency based on system state
            const concurrencyCheckInterval = setInterval(() => {
                maxConcurrentBlocks = calculateOptimalConcurrency();
            }, 2000);

            function fail(err){
                if( parser ){
                    parser.close();
                }
                clearInterval(progressInterval);
                clearInterval(concurrencyCheckInterval);
                return opts.error(err);
            }

            function visitNextBlock(){
                var fileBlock;
                // Allow multiple blocks to be processed concurrently
                while (!documentEndReached && !paused && 
                       concurrentBlocks < maxConcurrentBlocks && 
                       nextFileBlockIndex < parser.fileBlocks.length) {
                    
                    processFileBlock();
                }
            }

            function processFileBlock() {
                if(nextFileBlockIndex >= parser.fileBlocks.length){
                    if (concurrentBlocks === 0) {
                        documentEndReached = true;
                        if(opts.verbose){
                          logVerbose("All file blocks processed. Closing parser.", { globalOffset: "N/A" });
                        }
                        parser.close();
                        clearInterval(progressInterval);
                        clearInterval(concurrencyCheckInterval);
                        opts.endDocument();
                    }
                    return;
                }
                
                var fileBlock = parser.fileBlocks[nextFileBlockIndex];
                fileBlock.blobIndex = nextFileBlockIndex;
                nextFileBlockIndex++;
                concurrentBlocks++;
                
                if(opts.verbose){
                  logVerbose("Found file block", {
                     blobIndex: fileBlock.blobIndex,
                     fileBlockPosition: fileBlock.position,
                     headerType: fileBlock.blobHeader.type,
                     datasize: fileBlock.blobHeader.datasize,
                     globalOffset: fileBlock.position
                  });
                }
                
                // Always invoke the found callback.
                opts.found({ 
                     event: "foundFileBlock",
                     blobIndex: fileBlock.blobIndex,
                     globalOffset: fileBlock.position,
                     parentOffset: null
                });
                
                if(opts.verbose && fileBlock.blobHeader.type !== "OSMData"){
                    logVerbose("BlobHeader type", fileBlock.blobHeader.type);
                }
                bytesRead += fileBlock.size;
                
                parser.readBlock(fileBlock, function(err, block){
                    concurrentBlocks--; // Decrement when block processing completes
                    
                    if(err){
                        return fail(err);
                    }
                    
                    opts.found({
                        event: "blockDecoded",
                        blobIndex: fileBlock.blobIndex,
                        globalOffset: fileBlock.position,
                        parentOffset: fileBlock.position
                    });
                    
                    if(opts.verbose && fileBlock.blobHeader.type !== "OSMData"){
                      logVerbose("Finished reading block", {
                        blobIndex: fileBlock.blobIndex,
                        headerType: fileBlock.blobHeader.type,
                        status: block ? "Decoding successful" : "Decoding failed or block empty",
                        globalOffset: fileBlock.position
                      });
                    }
                    
                    visitBlock(fileBlock, block, opts);
                    
                    // Periodic memory optimization for large files
                    blockProcessedCount++;
                    if (blockProcessedCount % 100 === 0) {
                        optimizeMemoryUsage();
                    }
                    
                    // Process more blocks if capacity is available
                    visitNextBlock();
                });
            }

            resumeCallback = visitNextBlock;
            visitNextBlock();
        }
    });

    function pause(){
        paused = true;
    }

    function resume(){
        paused = false;
        if(resumeCallback){
            resumeCallback();
        }
    }

    return {
        pause: pause,
        resume: resume
    };
}

function createPathParser(opts){
    reader = getReader(opts);
    reader.open(opts, function(err, fd){
        createFileParser(fd, function(err, parser){
            if(err){
                return opts.callback(err);
            }

            parser.close = function(callback){
                return reader.close(fd, callback);
            };

            return opts.callback(null, parser);
        });
    });
}

function getReader(opts){
    if(!arrayBufferReader){
        // Node.js
        return reader;
    }

    if(opts.file){
        return fileReader;
    }
    return arrayBufferReader;
}

function visitBlock(fileBlock, block, opts){
    BLOCK_VISITORS_BY_TYPE[fileBlock.blobHeader.type](block, opts);
}

function visitOSMHeaderBlock(block, opts) {
    if (opts.verbose) {
        console.log("Processing OSMHeader block:", block);
    }

    // Extract required features
    const requiredFeatures = block.required_features || [];
    if (opts.requiredFeaturesCallback) {
        opts.requiredFeaturesCallback(requiredFeatures);
    }

    // Extract bounding box and convert Long to numbers
    const bbox = block.bbox || {};
    const convertedBbox = {
        left: bbox.left ? bbox.left.toNumber() : undefined,
        right: bbox.right ? bbox.right.toNumber() : undefined,
        top: bbox.top ? bbox.top.toNumber() : undefined,
        bottom: bbox.bottom ? bbox.bottom.toNumber() : undefined,
    };
    if (opts.bboxCallback) {
        opts.bboxCallback(convertedBbox);
    }
}

function visitOSMDataBlock(block, opts){
    var i;

    for(i = 0; i < block.primitivegroup.length; ++i){
        visitPrimitiveGroup(block.primitivegroup[i], opts);
    }
}

function visitPrimitiveGroup(pg, opts){
    var i;

    // visit nodes
    if(opts.node){
        for(i = 0; i < pg.nodesView.length; ++i){
            opts.node(pg.nodesView.get(i));
        }
    }

    // visit ways
    if(opts.way){
        for(i = 0; i < pg.waysView.length; ++i){
            opts.way(pg.waysView.get(i));
        }
    }

    // visit relations
    if(opts.relation){
        for(i = 0; i < pg.relationsView.length; ++i){
            opts.relation(pg.relationsView.get(i));
        }
    }
}

var BLOCK_VISITORS_BY_TYPE = {
    OSMHeader: visitOSMHeaderBlock,
    OSMData: visitOSMDataBlock
};

var BLOB_HEADER_SIZE_SIZE = 4;

function readBlobHeaderContent(fd, position, size, callback){
    return reader.readPBFElement(fd, position, size, proto.OSMPBF.BlobHeader.decode, callback);
}

function readFileBlock(fd, position, callback){
    //console.log('pre reader.readBlobHeaderSize position:', position);
    reader.readBlobHeaderSize(fd, position, BLOB_HEADER_SIZE_SIZE, function(err, blobHeaderSize){
        if(err){
            return callback(err);
        }

        //console.log('blobHeaderSize', blobHeaderSize);

        return readBlobHeaderContent(fd, position + BLOB_HEADER_SIZE_SIZE, blobHeaderSize, function(err, blobHeader){
            if(err){
                return callback(err);
            }

            blobHeader.position = position + BLOB_HEADER_SIZE_SIZE + blobHeaderSize;

            //console.log('blobHeader', blobHeader);

            return callback(err, {
                position: position,
                size: BLOB_HEADER_SIZE_SIZE + blobHeaderSize + blobHeader.datasize,
                blobHeader: blobHeader
            });
        });
    });
}

function readFileBlocks(fd, callback){
    reader.getFileSize(fd, function(err, fileSize){
        var position, fileBlocks, lastReportTime = Date.now();

        position = 0;
        fileBlocks = [];

        function readNextFileBlock(){
            //console.log('pre readNextFileBlock position:', position)
            readFileBlock(fd, position, function(err, fileBlock){
                if(err){
                    return callback(err);
                }

                fileBlocks.push(fileBlock);

                position = fileBlock.position + fileBlock.size;

                // Report progress every 500ms during file block scanning
                const now = Date.now();
                if (now - lastReportTime > 500) {
                    const percentScanned = ((position / fileSize) * 100).toFixed(1);
                    console.log(`Scanning file blocks: ${percentScanned}% (${fileBlocks.length} blocks found)`);
                    lastReportTime = now;
                }

                if(position < fileSize){
                    readNextFileBlock();
                }
                else{
                    console.log(`File block scanning complete: ${fileBlocks.length} blocks found`);
                    return callback(null, fileBlocks);
                }
            });
        }
        //console.log('*pre readNextFileBlock position:', position)
        readNextFileBlock();
    });
}

function getStringTableEntry(i){
    var s, str;

    // Validate index bounds
    if (i < 0 || i >= this.s.length) {
        console.warn(`StringTable index ${i} out of bounds (length: ${this.s.length})`);
        return '';
    }

    // decode StringTable entry only once and cache (using Map for better performance)
    if (this.cache.has(i)) {
        return this.cache.get(i);
    }
    
    s = this.s[i];

    // Validate that the string entry exists
    if (!s) {
        console.warn(`StringTable entry at index ${i} is undefined`);
        return '';
    }

    try {
        str = protobuf.util.utf8.read(s, 0, s.length);
    } catch (error) {
        console.warn(`Error reading StringTable entry at index ${i}:`, error.message);
        return '';
    }
    
    this.cache.set(i, str);
    return str;
}

function extendStringTable(st){
    if (!st || !st.s) {
        console.warn('Invalid StringTable provided to extendStringTable');
        st = { s: [], cache: {} };
    }
    
    // Pre-allocate cache with better performance characteristics
    st.cache = new Map(); // Use Map instead of object for better performance
    st.getEntry = getStringTableEntry;
    
    // Pre-decode common/small strings for better performance
    if (st.s && st.s.length > 0) {
        for (let i = 0; i < Math.min(st.s.length, 100); i++) { // Pre-decode first 100 entries
            if (st.s[i] && st.s[i].length < 50) { // Only pre-decode small strings
                try {
                    const str = protobuf.util.utf8.read(st.s[i], 0, st.s[i].length);
                    st.cache.set(i, str);
                } catch (e) {
                    // Skip problematic entries
                }
            }
        }
    }
}

function createNodesView(pb, pg){
    let length = 0, tagsList = [], deltaData;

    if(pg.nodes.length !== 0){
        throw new Error('primitivegroup.nodes.length !== 0 not supported yet');
    }

    if(pg.dense){
        length = pg.dense.id.length;

        // Populate tagsList
        for (let i = 0; i < length; i++) {
            const tags = {};
            if (pg.dense.keysVals && pg.dense.keysVals.length > 0) {
                let j = pg.dense.keysVals[i];
                while (j < pg.dense.keysVals.length && pg.dense.keysVals[j] !== 0) {
                    // Ensure we have both key and value indices
                    if (j + 1 >= pg.dense.keysVals.length) {
                        console.warn(`Incomplete key-value pair at index ${j} in keysVals`);
                        break;
                    }
                    
                    const keyIndex = pg.dense.keysVals[j];
                    const valueIndex = pg.dense.keysVals[j + 1];
                    
                    // Validate StringTable access
                    if (!pb.stringtable) {
                        console.warn('StringTable is not available');
                        break;
                    }
                    
                    const key = pb.stringtable.getEntry(keyIndex);
                    const value = pb.stringtable.getEntry(valueIndex);
                    
                    if (key && value) {
                        tags[key] = value;
                    }
                    j += 2;
                }
            }
            tagsList.push(tags);
        }
    }

    function collectDeltaData(){
        let i, id, timestamp, changeset, uid, userIndex, deltaDataList, deltaData, lat, lon;

        if(!pg.dense){
            return null;
        }

        id = 0;
        lat = 0;
        lon = 0;

        if(pg.dense.denseinfo){
            timestamp = 0;
            changeset = 0;
            uid = 0;
            userIndex = 0;
        }

        deltaDataList = [];

        for(i = 0; i < length; ++i){
            id += toNumber(pg.dense.id[i]);
            lat += toNumber(pg.dense.lat[i]);
            lon += toNumber(pg.dense.lon[i]);

            deltaData = {
                id: id,
                lat: lat,
                lon: lon
            };

            if(pg.dense.denseinfo){
                timestamp += toNumber(pg.dense.denseinfo.timestamp[i]);
                changeset += toNumber(pg.dense.denseinfo.changeset[i]);
                uid += toNumber(pg.dense.denseinfo.uid[i]);
                userIndex += toNumber(pg.dense.denseinfo.userSid[i]);

                deltaData.timestamp = timestamp * pb.dateGranularity;
                deltaData.changeset = changeset;
                deltaData.uid = uid;
                deltaData.userIndex = userIndex;
            }

            deltaDataList.push(deltaData);
        }

        return deltaDataList;
    }

    function get(i){
        if (deltaData === undefined) deltaData = collectDeltaData();
        const nodeDeltaData = deltaData[i], node = {
            id: toNumber(nodeDeltaData.id),
            lat: (toNumber(pb.latOffset) + (pb.granularity * nodeDeltaData.lat)) / 1000000000,
            lon: (toNumber(pb.lonOffset) + (pb.granularity * nodeDeltaData.lon)) / 1000000000,
            tags: tagsList[i]
        };

        if(pg.dense.denseinfo){
            node.version = pg.dense.denseinfo.version[i];
            node.timestamp = nodeDeltaData.timestamp;
            node.changeset = nodeDeltaData.changeset;
            node.uid = toNumber(nodeDeltaData.uid);
            node.user = pb.stringtable.getEntry(nodeDeltaData.userIndex);
        }

        return node;
    }

    return {
        length,
        get
    };
}

function createWaysView(pb, pg){
    // Debug logging removed for performance
    const length = pg.ways.length;

    function get(i){
        const way = pg.ways[i];

        const result = {
            id: toNumber(way.id),
            tags: createTagsObject(pb, way),
            nodeRefs: way.refs.map(ref => toNumber(ref))
        };

        addInfo(pb, result, way.info);

        return result;
    }

    return {
        length,
        get
    };
}

function createRelationsView(pb, pg){
    const length = pg.relations.length;

    function get(i){
        const relation = pg.relations[i];

        const result = {
            id: toNumber(relation.id),
            tags: createTagsObject(pb, relation),
            members: relation.memids.map((memid, index) => ({
                ref: toNumber(memid),
                role: pb.stringtable.getEntry(relation.rolesSid[index]),
                type: relation.types[index]
            }))
        };

        addInfo(pb, result, relation.info);

        return result;
    }

    return {
        length,
        get
    };
}

function createTagsObject(pb, entity){
    let tags = {}, i, len, keyI, valI, key, val;

    for(i = 0, len = entity.keys.length; i < len; ++i){
        keyI = entity.keys[i];
        valI = entity.vals[i];

        key = pb.stringtable.getEntry(keyI);
        val = pb.stringtable.getEntry(valI);

        tags[key] = val;
    }

    return tags;
}

function addInfo(pb, result, info){
    if (info) {
        if (info.version) {
            result.version = info.version;
        }
        if (info.timestamp) {
            result.timestamp = toNumber(info.timestamp) * pb.dateGranularity;
        }
        if (info.changeset) {
            result.changeset = toNumber(info.changeset);
        }
        if (info.uid) {
            result.uid = '' + info.uid;
        }
    }
}

function toNumber(x) {
    if (typeof x === 'number') {
        return x;
    } else if (typeof x === 'bigint') {
        return Number(x); // Convert BigInt to Number
    } else if (typeof x === 'string') {
        const parsed = parseFloat(x);
        if (!isNaN(parsed)) {
            return parsed; // Handle string representations of numbers
        }
    } else if (x instanceof Long) {
        return x.toNumber(); // Handle Long objects
    }
    throw new Error(`Unsupported ID format: ${x}`);
}

function extendPrimitiveGroup(pb, pg){
    pg.nodesView = createNodesView(pb, pg);
    pg.waysView = createWaysView(pb, pg);
    pg.relationsView = createRelationsView(pb, pg);
}

function decodePrimitiveBlock(buffer){
    let data = proto.OSMPBF.PrimitiveBlock.decode(buffer), i;
    const pgl = data.primitivegroup.length;
    // extend stringtable
    extendStringTable(data.stringtable);

    // extend primitivegroup
    
    for(i = 0; i < pgl; ++i){
        extendPrimitiveGroup(data, data.primitivegroup[i]);
    }

    return data;
}

var OSM_BLOB_DECODER_BY_TYPE = {
    'OSMHeader': proto.OSMPBF.HeaderBlock.decode,
    'OSMData': decodePrimitiveBlock
};

function createFileParser(fd, callback){
    readFileBlocks(fd, function(err, fileBlocks){
        if(err){
            return callback(err);
        }

        function findFileBlocksByBlobType(blobType){
            var blocks, i, block;

            blocks = [];

            for(i = 0; i < fileBlocks.length; ++i){
                block = fileBlocks[i];

                if(block.blobHeader.type !== blobType){
                    continue;
                }

                blocks.push(block);
            }

            return blocks;
        }

        function readBlob(fileBlock, callback){
            return reader.readPBFElement(fd, fileBlock.blobHeader.position, fileBlock.blobHeader.datasize, proto.OSMPBF.Blob.decode, callback);
        }

        function readBlock(fileBlock, callback){
            return readBlob(fileBlock, function(err, blob){
                if(err){
                    return callback(err);
                }

                if(blob.rawSize === 0){
                    return callback('Uncompressed pbfs are currently not supported.');
                }

                // Enhanced intelligent worker thread usage based on multiple factors
                const dataSize = blob.zlibData ? blob.zlibData.length : 0;
                const rawSize = blob.rawSize || 1;
                const compressionRatio = dataSize / rawSize;
                
                // More sophisticated thresholds for worker thread usage
                const isLargeBlock = dataSize > 256 * 1024; // Lowered to 256KB for better parallelization
                const isVeryLargeBlock = dataSize > 1024 * 1024; // 1MB+ blocks get high priority
                const isHighlyCompressed = compressionRatio < 0.25; // Highly compressed (< 25% of original)
                const isExtremelyCompressed = compressionRatio < 0.15; // Extremely compressed (< 15% of original)
                const isOSMDataBlock = fileBlock.blobHeader.type === 'OSMData';
                
                // Determine if we should use worker threads and at what priority
                const shouldUseWorkers = (
                    isLargeBlock || 
                    isHighlyCompressed || 
                    isOSMDataBlock ||
                    (dataSize > 128 * 1024 && compressionRatio < 0.4) // Medium blocks with decent compression
                );
                
                // Determine priority for worker thread scheduling
                let priority = 'normal';
                if (isVeryLargeBlock || isExtremelyCompressed) {
                    priority = 'high';
                } else if (isHighlyCompressed && isOSMDataBlock) {
                    priority = 'high';
                }
                
                zlib.inflateBlob(blob, function(err, data){
                    if(err){
                        return callback(err);
                    }

                    return buf.readPBFElementFromBuffer(data, OSM_BLOB_DECODER_BY_TYPE[fileBlock.blobHeader.type], callback);
                }, shouldUseWorkers, priority);
            });
        }

        return callback(null, {
            fileBlocks: fileBlocks,

            findFileBlocksByBlobType: findFileBlocksByBlobType,

            readBlock: readBlock
        });
    });
}

// Memory management and cleanup for large file processing
function optimizeMemoryUsage() {
    if (global.gc) {
        // Force garbage collection periodically for large files
        global.gc();
    }
}

// Add periodic memory optimization
var blockProcessedCount = 0;

module.exports = {
    parse: parse,

    createParser: createPathParser
};

if (require.main === module) {
    const fs = require('fs');
    const path = process.argv[2];

    if (!path) {
        console.error("Please provide the path to a PBF file.");
        process.exit(1);
    }

    console.log("Running pbfParser directly from the command line.");

    module.exports.createParser({
        filePath: path,
        callback: (err, parser) => {
            if (err) {
                console.error("Error creating parser:", err);
                process.exit(1);
            }

            const headers = parser.findFileBlocksByBlobType('OSMHeader');
            if (headers.length === 0) {
                console.log("No OSMHeader block found.");
                process.exit(0);
            }

            parser.readBlock(headers[0], (err, block) => {
                if (err) {
                    console.error("Error reading OSMHeader block:", err);
                    process.exit(1);
                }

                console.log("Decoded OSMHeader block:", block);
                process.exit(0);
            });
        }
    });
}
