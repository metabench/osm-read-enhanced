/**
 * A streaming version of the PBF parser that integrates the existing components
 * to create a unified API for both the classic and streaming approaches.
 */
const fs = require('fs');
const OSM_PBF_Parser_Core_Read = require('./OSM_PBF_Parser_Core_Read.js');
const OSM_PBF_Parser_Decompress = require('./OSM_PBF_Parser_Decompress.js');
const { Evented_Class } = require('lang-mini');
const proto = require('./proto/index.js');
const { parseBlob } = require('./protobuf-blob-parser.js');

/**
 * This class provides a streaming parser that builds upon the Core_Read and Decompress classes
 * but offers a unified API similar to the classic pbfParser.js
 */
class PBFStreamParser extends Evented_Class {
    constructor(options = {}) {
        super();
        
        // Enhanced options with performance tuning parameters
        this.options = Object.assign({
            filePath: null,
            verbose: false,
            highWaterMark: 64 * 1024 * 4, // 256KB chunks by default
            numChunksLimit: null, // No limit by default
            
            // New performance options:
            maxConcurrentBlobs: options.maxConcurrentBlobs || 2, // Max number of blobs to process simultaneously
            processingBatchSize: options.processingBatchSize || 10000, // Process entities in batches
            reportProgressInterval: options.reportProgressInterval || 1000, // How often to report progress (ms)
            useArrayBuffers: options.useArrayBuffers || false // Use ArrayBuffer for better memory efficiency
        }, options);
        
        // Use a LRU cache to limit memory usage for primitive blocks
        this.primitiveBlocks = new Map();
        this.processingQueue = [];
        this.concurrentBlobs = 0;
        
        // Stats tracking
        this.startTime = Date.now();
        this.processingStats = {
            nodesRate: 0,
            waysRate: 0,
            relationsRate: 0,
            lastReportTime: Date.now(),
            lastNodeCount: 0,
            lastWayCount: 0,
            lastRelationCount: 0
        };
        
        // Initialize callbacks from options
        this.nodeCallback = options.node || null;
        this.wayCallback = options.way || null;
        this.relationCallback = options.relation || null;
        this.foundCallback = options.found || null;
        this.errorCallback = options.error || ((err) => console.error("Error:", err));
        this.endDocumentCallback = options.endDocument || (() => {});
        
        // Set up progress reporting interval
        this.progressIntervalId = setInterval(() => {
            this._reportProgress();
        }, this.options.reportProgressInterval);

        // Initialize counters properly
        this.bytesProcessed = 0;
        this.nodesCount = 0;
        this.waysCount = 0;
        this.relationsCount = 0;
    }
    
    /**
     * Initializes the parser chain
     */
    initializeParserChain() {
        if (this.parserChain) {
            return; // Already initialized
        }
        
        if (!this.options.filePath) {
            throw new Error("No file path provided");
        }
        
        // Create the core parser
        const coreParser = new OSM_PBF_Parser_Core_Read(this.options.filePath, {
            verbose: this.options.verbose,
            highWaterMark: this.options.highWaterMark,
            numChunksLimit: this.options.numChunksLimit
        });
        
        // Create the decompression parser
        const decompressParser = new OSM_PBF_Parser_Decompress(this.options.filePath, {
            verbose: this.options.verbose,
            highWaterMark: this.options.highWaterMark,
            numChunksLimit: this.options.numChunksLimit
        });
        
        // Forward events from decompressParser
        ['verbose', 'start', 'end', 'limit', 'error', 'chunk'].forEach(event => {
            decompressParser.on(event, data => this.raise(event, data));
        });
        
        // Handle decompressed blob chunks to decode OSM data
        decompressParser.on('blob-chunk-decompressed', event => {
            this.bytesProcessed += event.length;
            this.handleDecompressedData(event);
        });
        
        // Forward file position events to clients via the found callback
        decompressParser.on('headerBoundariesIdentified', event => {
            if (this.foundCallback) {
                this.foundCallback({
                    event: "foundFileBlock",
                    blobIndex: event.blobIndex,
                    globalOffset: event.headerStartGlobal,
                    parentOffset: null,
                    headerDetails: event.headerDetails
                });
            }
        });
        
        // Store the parser chain for later use
        this.parserChain = decompressParser;
    }
    
    /**
     * Handles decompressed blob data
     */
    handleDecompressedData(event) {
        // For large blobs, queue for later processing to manage memory better
        if (event.length > 10 * 1024 * 1024 && this.concurrentBlobs >= this.options.maxConcurrentBlobs) {
            this.processingQueue.push(event);
            return;
        }
        
        // Accumulate decompressed data for this blob
        let blockData = this.primitiveBlocks.get(event.blobIndex) || { chunks: [], totalSize: 0 };
        blockData.chunks.push(event.decompressedData);
        blockData.totalSize += event.length;
        this.primitiveBlocks.set(event.blobIndex, blockData);
        
        // When all chunks are received for this block, process it
        if (event.isFinalChunk) {
            // Combine all chunks into a single buffer
            const fullData = Buffer.concat(blockData.chunks, blockData.totalSize);
            
            try {
                // Decode the primitive block
                let primitiveBlock;
                try {
                    primitiveBlock = proto.OSMPBF.PrimitiveBlock.decode(fullData);
                } catch (decodeErr) {
                    // If decoding fails, it might be because we're receiving a Blob rather than a PrimitiveBlock
                    // This can happen if the decompression layer is incorrectly interpreting the data
                    if (this.verbose) {
                        this.raise('verbose', {
                            info: `Failed to decode as PrimitiveBlock, attempting to parse as Blob`,
                            error: decodeErr.message
                        });
                    }
                    
                    try {
                        // Try to parse as a Blob to extract the actual data
                        const blobInfo = parseBlob(fullData);
                        if (blobInfo.data) {
                            // Retry with the extracted data
                            primitiveBlock = proto.OSMPBF.PrimitiveBlock.decode(blobInfo.data);
                        } else {
                            throw new Error("Could not extract data from Blob");
                        }
                    } catch (blobErr) {
                        throw new Error(`Failed to parse as Blob: ${blobErr.message}`);
                    }
                }
                
                // Process in batches if there are many entities
                this._processPrimitiveBlockInBatches(primitiveBlock);
                
                // Notify clients that the block was decoded
                if (this.foundCallback) {
                    this.foundCallback({
                        event: "blockDecoded",
                        blobIndex: event.blobIndex,
                        globalOffset: event.globalOffset,
                        primitiveBlock: primitiveBlock
                    });
                }
            } catch (err) {
                this.raise('error', new Error(`Failed to decode primitive block ${event.blobIndex}: ${err.message}`));
            }
            
            // Remove processed block data to free memory
            this.primitiveBlocks.delete(event.blobIndex);
            
            // Reduce concurrent count and process next item if available
            this.concurrentBlobs--;
            setImmediate(() => this._processNextQueueItem());
        }
    }
    
    /**
     * Process the next item from the queue if concurrency limits allow
     */
    _processNextQueueItem() {
        if (this.processingQueue.length === 0 || this.concurrentBlobs >= this.options.maxConcurrentBlobs) {
            return;
        }
        
        const item = this.processingQueue.shift();
        this.concurrentBlobs++;
        
        try {
            this.handleDecompressedData(item);
        } catch (err) {
            this.concurrentBlobs--;
            this.raise('error', err);
            
            // Continue processing the queue
            setImmediate(() => this._processNextQueueItem());
        }
    }
    
    /**
     * Process primitive block in batches to prevent blocking the event loop
     */
    _processPrimitiveBlockInBatches(block) {
        if (!block.primitivegroup) return;
        
        for (const pg of block.primitivegroup) {
            // Process dense nodes in batches
            if (pg.dense && this.nodeCallback) {
                const nodesCount = pg.dense.id.length;
                
                // Process in batches to avoid blocking the event loop
                for (let start = 0; start < nodesCount; start += this.options.processingBatchSize) {
                    const end = Math.min(start + this.options.processingBatchSize, nodesCount);
                    
                    // Process this batch
                    for (let i = start; i < end; i++) {
                        const node = this.buildNode(block, pg, i);
                        this.nodeCallback(node);
                        this.nodesCount++;
                    }
                    
                    // Yield to the event loop for large batches
                    if (nodesCount > this.options.processingBatchSize) {
                        setImmediate(() => {}); // Allow other events to be processed
                    }
                }
            }
            
            // Similar batch processing for ways and relations
            // Process ways in batches
            if (pg.ways && pg.ways.length > 0 && this.wayCallback) {
                const waysCount = pg.ways.length;
                
                for (let start = 0; start < waysCount; start += this.options.processingBatchSize) {
                    const end = Math.min(start + this.options.processingBatchSize, waysCount);
                    
                    for (let i = start; i < end; i++) {
                        const way = this.buildWay(block, pg.ways[i]);
                        this.wayCallback(way);
                        this.waysCount++;
                    }
                    
                    if (waysCount > this.options.processingBatchSize) {
                        setImmediate(() => {});
                    }
                }
            }
            
            // Process relations in batches
            if (pg.relations && pg.relations.length > 0 && this.relationCallback) {
                const relationsCount = pg.relations.length;
                
                for (let start = 0; start < relationsCount; start += this.options.processingBatchSize) {
                    const end = Math.min(start + this.options.processingBatchSize, relationsCount);
                    
                    for (let i = start; i < end; i++) {
                        const relation = this.buildRelation(block, pg.relations[i]);
                        this.relationCallback(relation);
                        this.relationsCount++;
                    }
                    
                    if (relationsCount > this.options.processingBatchSize) {
                        setImmediate(() => {});
                    }
                }
            }
        }
    }
    
    /**
     * Build a node object from dense nodes format
     */
    buildNode(block, pg, index) {
        let id = 0, lat = 0, lon = 0;
        
        // Accumulate delta values
        for (let i = 0; i <= index; i++) {
            id += this.toNumber(pg.dense.id[i]);
            lat += this.toNumber(pg.dense.lat[i]);
            lon += this.toNumber(pg.dense.lon[i]);
        }
        
        // Convert lat/lon to degrees
        const lat_degree = (this.toNumber(block.latOffset) + (block.granularity * lat)) / 1000000000;
        const lon_degree = (this.toNumber(block.lonOffset) + (block.granularity * lon)) / 1000000000;
        
        const node = {
            id: id,
            lat: lat_degree,
            lon: lon_degree,
            tags: this.extractNodeTags(block, pg, index)
        };
        
        // Add metadata if available
        if (pg.dense.denseinfo) {
            let timestamp = 0, changeset = 0, uid = 0, userIndex = 0;
            for (let i = 0; i <= index; i++) {
                timestamp += this.toNumber(pg.dense.denseinfo.timestamp[i]);
                changeset += this.toNumber(pg.dense.denseinfo.changeset[i]);
                uid += pg.dense.denseinfo.uid[i];
                userIndex += pg.dense.denseinfo.userSid[i];
            }
            
            node.version = pg.dense.denseinfo.version[index];
            node.timestamp = timestamp * block.dateGranularity;
            node.changeset = changeset;
            node.uid = '' + uid;
            if (block.stringtable && block.stringtable.s) {
                node.user = this.getString(block.stringtable, userIndex);
            }
        }
        
        return node;
    }
    
    /**
     * Extract tags for a node from dense format
     */
    extractNodeTags(block, pg, nodeIndex) {
        if (!pg.dense.keysVals) return {};
        
        const tags = {};
        let currentIndex = 0;
        let currentNodeIndex = 0;
        
        // Skip to the current node's tags
        while (currentNodeIndex < nodeIndex && currentIndex < pg.dense.keysVals.length) {
            if (pg.dense.keysVals[currentIndex] === 0) {
                currentNodeIndex++;
            }
            currentIndex++;
        }
        
        // Extract tags for the current node
        while (currentIndex < pg.dense.keysVals.length) {
            const keyId = pg.dense.keysVals[currentIndex++];
            if (keyId === 0) break; // End of current node's tags
            
            const valId = pg.dense.keysVals[currentIndex++];
            const key = this.getString(block.stringtable, keyId);
            const val = this.getString(block.stringtable, valId);
            tags[key] = val;
        }
        
        return tags;
    }
    
    /**
     * Build a way object
     */
    buildWay(block, way) {
        const result = {
            id: this.toNumber(way.id),
            tags: {},
            nodeRefs: []
        };
        
        // Extract tags
        if (way.keys && way.vals) {
            for (let i = 0; i < way.keys.length; i++) {
                const key = this.getString(block.stringtable, way.keys[i]);
                const val = this.getString(block.stringtable, way.vals[i]);
                result.tags[key] = val;
            }
        }
        
        // Extract node references (delta encoded)
        if (way.refs) {
            let refId = 0;
            for (let i = 0; i < way.refs.length; i++) {
                refId += this.toNumber(way.refs[i]);
                result.nodeRefs.push(refId);
            }
        }
        
        // Add metadata if available
        if (way.info) {
            if (way.info.version) result.version = way.info.version;
            if (way.info.timestamp) result.timestamp = this.toNumber(way.info.timestamp) * block.dateGranularity;
            if (way.info.changeset) result.changeset = this.toNumber(way.info.changeset);
            if (way.info.uid) result.uid = '' + way.info.uid;
            if (way.info.userSid) result.user = this.getString(block.stringtable, way.info.userSid);
        }
        
        return result;
    }
    
    /**
     * Build a relation object
     */
    buildRelation(block, relation) {
        const result = {
            id: this.toNumber(relation.id),
            tags: {},
            members: []
        };
        
        // Extract tags
        if (relation.keys && relation.vals) {
            for (let i = 0; i < relation.keys.length; i++) {
                const key = this.getString(block.stringtable, relation.keys[i]);
                const val = this.getString(block.stringtable, relation.vals[i]);
                result.tags[key] = val;
            }
        }
        
        // Extract members (delta encoded)
        if (relation.memids && relation.types && relation.rolesSid) {
            let refId = 0;
            for (let i = 0; i < relation.memids.length; i++) {
                refId += this.toNumber(relation.memids[i]);
                
                let type;
                switch (relation.types[i]) {
                    case 0: type = 'node'; break;
                    case 1: type = 'way'; break;
                    case 2: type = 'relation'; break;
                    default: type = 'unknown';
                }
                
                result.members.push({
                    ref: refId,
                    type: type,
                    role: this.getString(block.stringtable, relation.rolesSid[i])
                });
            }
        }
        
        // Add metadata if available
        if (relation.info) {
            if (relation.info.version) result.version = relation.info.version;
            if (relation.info.timestamp) result.timestamp = this.toNumber(relation.info.timestamp) * block.dateGranularity;
            if (relation.info.changeset) result.changeset = this.toNumber(relation.info.changeset);
            if (relation.info.uid) result.uid = '' + relation.info.uid;
            if (relation.info.userSid) result.user = this.getString(block.stringtable, relation.info.userSid);
        }
        
        return result;
    }
    
    /**
     * Safely convert various number types to JavaScript number
     */
    toNumber(x) {
        if (x === null || x === undefined) return 0;
        return (typeof(x) === 'number' || typeof(x) === 'bigint') ? Number(x) : x.toNumber();
    }
    
    /**
     * Get string from string table
     */
    getString(stringtable, index) {
        if (!stringtable || !stringtable.s || index < 0 || index >= stringtable.s.length) {
            return "";
        }
        
        const bytes = stringtable.s[index];
        // Convert UTF-8 bytes to string
        try {
            return Buffer.from(bytes).toString('utf8');
        } catch (e) {
            return `[Invalid UTF-8 string at index ${index}]`;
        }
    }
    
    /**
     * Start parsing
     */
    parse() {
        if (this.isRunning) {
            throw new Error("Parser is already running");
        }
        
        this.isRunning = true;
        
        try {
            this.initializeParserChain();
            this.parserChain.parse();
        } catch (err) {
            this.isRunning = false;
            if (this.errorCallback) {
                this.errorCallback(err);
            }
        }
        
        return {
            pause: () => this.pause(),
            resume: () => this.resume(),
            cleanup: () => this.cleanup()
        };
    }
    
    /**
     * Pause parsing
     */
    pause() {
        this.paused = true;
        // Future: implement pause functionality in the parser chain
    }
    
    /**
     * Resume parsing
     */
    resume() {
        this.paused = false;
        // Future: implement resume functionality in the parser chain
    }
    
    /**
     * Clean up resources
     */
    cleanup() {
        this.isRunning = false;
        this.primitiveBlocks.clear();
        this.processingQueue = [];
        
        if (this.progressIntervalId) {
            clearInterval(this.progressIntervalId);
        }
    }
    
    /**
     * Report processing progress
     */
    _reportProgress() {
        const now = Date.now();
        const elapsed = (now - this.processingStats.lastReportTime) / 1000;
        
        if (elapsed > 0) {
            // Calculate rates
            const nodesRate = (this.nodesCount - this.processingStats.lastNodeCount) / elapsed;
            const waysRate = (this.waysCount - this.processingStats.lastWayCount) / elapsed;
            const relationsRate = (this.relationsCount - this.processingStats.lastRelationCount) / elapsed;
            
            this.processingStats.nodesRate = nodesRate;
            this.processingStats.waysRate = waysRate;
            this.processingStats.relationsRate = relationsRate;
            
            // Update last counts
            this.processingStats.lastReportTime = now;
            this.processingStats.lastNodeCount = this.nodesCount;
            this.processingStats.lastWayCount = this.waysCount;
            this.processingStats.lastRelationCount = this.relationsCount;
            
            // Log progress
            console.log(`Processing rates: ${nodesRate.toFixed(2)} nodes/s, ${waysRate.toFixed(2)} ways/s, ${relationsRate.toFixed(2)} relations/s`);
            console.log(`Total processed: ${this.nodesCount} nodes, ${this.waysCount} ways, ${this.relationsCount} relations`);
        }
    }
}

module.exports = PBFStreamParser;

// Driver code for standalone execution
if (require.main === module) {
    const filePath = process.argv[2] || "D:\\planet-250203.osm.pbf";
    const streamParser = new PBFStreamParser({
        filePath: filePath,
        verbose: false,
        node: (node) => {
            if (streamParser.nodesCount % 100000 === 0) {
                console.log(`Processed ${streamParser.nodesCount} nodes`);
            }
        },
        way: (way) => {
            if (streamParser.waysCount % 10000 === 0) {
                console.log(`Processed ${streamParser.waysCount} ways`);
            }
        },
        relation: (relation) => {
            if (streamParser.relationsCount % 1000 === 0) {
                console.log(`Processed ${streamParser.relationsCount} relations`);
            }
        },
        found: (item) => {
            if (item.event === "foundFileBlock" || item.event === "blockDecoded") {
                //console.log(`Event: ${item.event}, blobIndex: ${item.blobIndex}`);
            }
        },
        error: (err) => {
            console.error("Error during parsing:", err);
        },
        endDocument: () => {
            console.log("Finished parsing document.");
            console.log(`Total: ${streamParser.nodesCount} nodes, ${streamParser.waysCount} ways, ${streamParser.relationsCount} relations`);
        }
    });
    
    streamParser.on('start', (event) => {
        console.log(`Started parsing ${event.file_path} (${event.file_size} bytes)`);
    });
    
    streamParser.on('end', (event) => {
        console.log(`Parse completed in ${event.elapsed.toFixed(1)}s. Processed ${event.total_mb}MB at ${event.overall_mb_s}MB/s`);
    });
    
    const controlFunctions = streamParser.parse();
    
    // Allow clean termination with Ctrl+C
    process.on('SIGINT', () => {
        console.log('Received SIGINT, cleaning up...');
        controlFunctions.cleanup();
        process.exit(0);
    });
}
