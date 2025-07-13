#### osm-read - an openstreetmap XML and PBF parser for node.js and the browser

1. Introduction
2. PBF File Format Structure
3. Usage Examples
    1. Simple Usage Example
    2. Parse OSM XML from URL Example
    3. PBF random access parser
    4. Progress Tracking and Verbose Logging
    5. Decompression Worker Configuration
4. Version Upgrade Guide
5. TODOs
6. License
7. Contact

------------------------------------------------------------------------
#### Introduction

osm-read parses openstreetmap XML and PBF files as described in
[http://wiki.openstreetmap.org/wiki/OSM_XML](http://wiki.openstreetmap.org/wiki/OSM_XML) and
[http://wiki.openstreetmap.org/wiki/PBF_Format](http://wiki.openstreetmap.org/wiki/PBF_Format)

This enhanced version includes:
- **Multi-threaded decompression** with configurable worker pool
- **Fast event-driven parsing** for high-performance applications
- **Lazy parsing methods** for memory-efficient processing
- **Comprehensive PBF format documentation** and low-level blob access

------------------------------------------------------------------------
#### PBF File Format Structure

The PBF (Protocol Buffer Binary Format) is a binary representation of OSM data using Google Protocol Buffers. Understanding this structure is crucial for efficient parsing and low-level blob access.

**File Structure Hierarchy:**

```
PBF File
├── FileBlock 1
│   ├── BlobHeader (4-byte length + protobuf message)
│   │   ├── type: "OSMHeader" or "OSMData"
│   │   ├── datasize: size of following Blob
│   │   └── indexdata: optional index information
│   └── Blob (protobuf message, compressed data)
│       ├── raw: uncompressed data OR
│       ├── zlib_data: zlib compressed data
│       ├── lzma_data: LZMA compressed data (rare)
│       └── raw_size: size after decompression
├── FileBlock 2
├── ...
└── FileBlock N
```

**Blob Content Structure (after decompression):**

**OSMHeader Blob:**
```
HeaderBlock
├── bbox: Optional bounding box (left, right, top, bottom)
├── required_features: Features required to read this file
├── optional_features: Optional features used in this file
├── writingprogram: Program that created this file
└── source: Source of the data
```

**OSMData Blob (PrimitiveBlock):**
```
PrimitiveBlock
├── stringtable: Array of UTF-8 strings (index 0 = empty string)
├── primitivegroup[]: Groups containing nodes, ways, or relations
├── granularity: Coordinate precision (default: 100 nanodegrees)
├── lat_offset, lon_offset: Coordinate offset values
└── date_granularity: Timestamp precision (default: 1000ms)
```

**PrimitiveGroup Contents (exactly one of):**
```
PrimitiveGroup
├── nodes[]: Individual Node messages (rarely used)
├── dense: DenseNodes message (packed nodes - most common)
├── ways[]: Way messages  
├── relations[]: Relation messages
└── changesets[]: Changeset messages (rare)
```

**DenseNodes Structure (most efficient node storage):**
```
DenseNodes
├── id[]: Delta-encoded node IDs (signed varint)
├── lat[], lon[]: Delta-encoded coordinates (signed varint)
├── keys_vals[]: Interleaved key/value string indices, 0-terminated
└── denseinfo: Optional metadata (versions, timestamps, users)
```

**Way Structure:**
```
Way
├── id: Way ID (int64)
├── keys[], vals[]: String table indices for tags
├── refs[]: Delta-encoded node references (signed varint)
└── info: Optional metadata
```

**Relation Structure:**
```
Relation
├── id: Relation ID (int64)
├── keys[], vals[]: String table indices for tags  
├── roles_sid[]: String table indices for member roles
├── memids[]: Delta-encoded member IDs (signed varint)
├── types[]: Member types (NODE=0, WAY=1, RELATION=2)
└── info: Optional metadata
```

**String Table Format:**
- Index 0: Always empty string ("")
- Index 1+: UTF-8 encoded strings referenced throughout the block
- All tag keys, values, usernames, etc. stored as indices for efficiency
- Strings decoded on-demand to save memory

**Coordinate Encoding:**
- Formula: `(offset + granularity * delta_value) / 1e9` degrees
- Default granularity: 100 nanodegrees = 1e-7 degrees precision
- Delta encoding: each value stored as difference from previous
- Lat/lon stored as signed integers, converted to floating point

**Data Processing Strategy:**
1. **File Level**: Read FileBlocks sequentially (parallelizable)
2. **Blob Level**: Decompress data (CPU intensive - use worker threads)
3. **Block Level**: Parse StringTable first (needed for all string lookups)
4. **Group Level**: Process PrimitiveGroups by type (nodes/ways/relations)
5. **Element Level**: Handle delta decoding and string table lookups

------------------------------------------------------------------------
#### Continuous Integration

[![Build Status](https://travis-ci.org/marook/osm-read.png?branch=master)](https://travis-ci.org/marook/osm-read)

------------------------------------------------------------------------
#### Simple Usage Example

The following code is used to parse openstreetmap XML or PBF files in a
SAX parser like callback way.

```javascript
var parser = osmread.parse({
    filePath: 'path/to/osm.xml',
    endDocument: function(){
        console.log('document end');
    },
    bounds: function(bounds){
        console.log('bounds: ' + JSON.stringify(bounds));
    },
    node: function(node){
        console.log('node: ' + JSON.stringify(node));
    },
    way: function(way){
        console.log('way: ' + JSON.stringify(way));
    },
    relation: function(relation){
        console.log('relation: ' + JSON.stringify(relation));
    },
    error: function(msg){
        console.log('error: ' + msg);
    }
});

// you can pause the parser
parser.pause();

// and resume it again
parser.resume();
```


------------------------------------------------------------------------
#### Parse PBF in the browser

The browser bundle 'osm-read-pbf.js' provides a global variable 'pbfParser' 
with a 'parse' method.

Example, see also example/pbf.html:

```html
<script src="../osm-read-pbf.js"></script>
<script>
    pbfParser.parse({
        filePath: 'test.pbf',
        endDocument: function(){
            console.log('document end');
        },
        node: function(node){
            console.log('node: ' + JSON.stringify(node));
        },
        way: function(way){
            console.log('way: ' + JSON.stringify(way));
        },
        relation: function(relation){
            console.log('relation: ' + JSON.stringify(relation));
        },
        error: function(msg){
            console.error('error: ' + msg);
            throw msg;
        }
    });
</script>
```

As an alternative to passing an URL in "filePath", the option "buffer" can be 
used to pass an already loaded ArrayBuffer object:

```javascript
var buf = ... // e.g. xhr.response

pbfParser.parse({
    buffer: buf,
...
```

A third alternative is to let the user choose a local file using the 
HTML5 File API, passing the file object as "file" option:

    <input type="file" id="file" accept=".pbf">
    <script>
        document.getElementById("file").addEventListener("change", parse, false);

        function parse(evt) {
            var file = evt.target.files[0];

            pbfParser.parse({
                file: file,
            ...

See also example/file.html

------------------------------------------------------------------------
#### Build

Build or update the browser bundle `osm-read-pbf.js` with browserify:
```bash
$ npm run browserify
```

To install browserify (http://browserify.org/):
```bash
$ npm install -g browserify
```

------------------------------------------------------------------------
#### Parse OSM XML from URL Example

Currently you can only parse OSM data in XML from URLs. Here's an example:

```javascript
osmread.parse({
    url: 'http://overpass-api.de/api/interpreter?data=node(51.93315273540566%2C7.567176818847656%2C52.000418429293326%2C7.687854766845703)%5Bhighway%3Dtraffic_signals%5D%3Bout%3B',
    format: 'xml',
    endDocument: function(){
        console.log('document end');
    },
    bounds: function(bounds){
        console.log('bounds: ' + JSON.stringify(bounds));
    },
    node: function(node){
        console.log('node: ' + JSON.stringify(node));
    },
    way: function(way){
        console.log('way: ' + JSON.stringify(way));
    },
    relation: function(relation){
        console.log('relation: ' + JSON.stringify(relation));
    },
    error: function(msg){
        console.log('error: ' + msg);
    }
});
```

------------------------------------------------------------------------
#### PBF random access parser

The following code allows to create a random access openstreetmap PBF
file parser:

```javascript
osmread.createPbfParser({
    filePath: 'path/to/osm.pbf',
    callback: function(err, parser){
        var headers;

        if(err){
            // TODO handle error
        }

        headers = parser.findFileBlocksByBlobType('OSMHeader');

        parser.readBlock(headers[0], function(err, block){
            console.log('header block');
            console.log(block);

            parser.close(function(err){
                if(err){
                    // TODO handle error
                }
            });
        });
    }
});
```

***Don't forget to close the parser after usage!***


------------------------------------------------------------------------
#### Progress Tracking and Verbose Logging

The PBF parser includes comprehensive progress tracking and debugging features:

**Progress Tracking:**
- Automatic progress reporting every second during parsing
- Shows MB/s throughput and total data processed
- File block scanning progress during initial file analysis

**Verbose Logging:**
```javascript
osmread.parse({
    filePath: 'path/to/osm.pbf',
    verbose: true, // Enable detailed logging
    node: function(node) { /* process node */ },
    endDocument: function() { console.log('Complete'); }
});
```

**Sample Output:**
```
Scanning file blocks: 45.2% (1247 blocks found)
File block scanning complete: 2756 blocks found
[VERBOSE] Starting pbf parsing. Opening file: path/to/osm.pbf
[VERBOSE] File opened successfully. Number of file blocks found: 2756
Progress: 15.7 MB/s, total read: 234.5 MB
[VERBOSE] Found file block { blobIndex: 1245, headerType: 'OSMData', datasize: 65536 }
Decompression workers: 16 active, 24 total, aggressive scaling
Progress: 18.3 MB/s, total read: 456.7 MB
```

------------------------------------------------------------------------
#### Decompression Worker Configuration

This enhanced version supports configurable multi-threaded decompression for improved performance on large PBF files.

**Configure Worker Pool:**

```javascript
const osmread = require('osm-read');

// Configure decompression workers
osmread.configureDecompressionWorkers({
    num_decompression_worker_threads: 16,    // Number of worker threads
    decompression_worker_scaling_mode: 'aggressive',  // Scaling mode
    enable_multithreading: true               // Enable/disable workers
});

// Scaling modes:
// - 'conservative': Gradual scaling, stable memory usage
// - 'aggressive': Fast scaling, maximum performance  
// - 'fixed': Fixed number of workers, no scaling

// Parse with configured workers
osmread.parse({
    filePath: 'large-file.osm.pbf',
    node: function(node) { /* process node */ },
    endDocument: function() { console.log('Complete'); }
});
```

**Get Worker Statistics:**

```javascript
const stats = osmread.getWorkerPoolStats();
console.log('Active workers:', stats.activeWorkers);
console.log('Total workers:', stats.totalWorkers);
console.log('Memory pressure:', stats.memoryPressure);
console.log('Scaling mode:', stats.scalingMode);
```

**Performance Tips:**
- Use 8-24 worker threads for large files (>100MB)
- 'aggressive' scaling mode provides best performance for large files
- 'conservative' mode uses less memory for smaller files
- Workers automatically shut down when not needed
- Decompression is the only multi-threaded operation - parsing remains single-threaded

------------------------------------------------------------------------
#### Low-Level Blob Access

For advanced use cases, you can access individual decompressed blobs:

```javascript
const OSM_Blob = require('osm-read/lib/OSM_Blob');

// Create blob from decompressed data
const blob = new OSM_Blob({ 
    index: 0, 
    data: decompressedBuffer 
});

// Lazy string table iteration
for (const str of blob.iterate_stringtable()) {
    console.log('String:', str);
}

// Get string by index (cached for performance)
const tagKey = blob.getStringByIndex(15);

// Lazy node iteration (memory efficient)
for (const node of blob.iterateNodes()) {
    console.log('Node:', node.id, node.lat, node.lon, node.tags);
}

// Fast event-driven parsing (high performance)
const EventEmitter = require('events');
const emitter = new EventEmitter();

emitter.on('node', (node) => {
    console.log('Fast node:', node.id);
});

blob.fastParse(emitter);
```

------------------------------------------------------------------------
#### Version Upgrade Guide

Sometimes APIs change... they break your code but things get easier for
the rest of us. I'm sorry if a version upgrade gives you some extra
hours. To makes things a little less painfull you can find migration
instructions in the file ChangeLog.


------------------------------------------------------------------------
#### TODOs

XML parser:  

- parse timestamps

------------------------------------------------------------------------
#### License

See file COPYING for details.


------------------------------------------------------------------------
#### Contact

author: Markus Peröbner <markus.peroebner@gmail.com>
