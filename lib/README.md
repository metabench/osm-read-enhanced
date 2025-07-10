# OSM Read Enhanced

This library provides enhanced OpenStreetMap PBF file parsing capabilities with multiple parsing strategies:

1. **Classic Parser** (`pbfParser.js`): The original parser, improved with better error handling, memory efficiency, and optional streaming features.

2. **Streaming Parser** (`pbf-stream-parser.js`): A new parser that processes data in chunks for better memory efficiency with large files.

3. **Low-level Components**:
   - `OSM_PBF_Parser_Core_read.js`: Handles raw PBF structure parsing
   - `OSM_PBF_Parser_Decompress.js`: Decompresses blob data

## Usage Examples

### Classic Parser (Backward Compatible)

```javascript
const osmRead = require('osm-read-enhanced');

osmRead.parse({
    filePath: 'map.osm.pbf',
    node: function(node) {
        console.log(`Node: ${node.id} at ${node.lat},${node.lon}`);
    },
    way: function(way) {
        console.log(`Way: ${way.id} with ${way.nodeRefs.length} nodes`);
    },
    relation: function(relation) {
        console.log(`Relation: ${relation.id} with ${relation.members.length} members`);
    },
    error: function(err) {
        console.error("Error:", err);
    },
    endDocument: function() {
        console.log("Parsing completed");
    }
});
```

### Streaming Parser (New)

```javascript
const osmRead = require('osm-read-enhanced');

const parser = osmRead.streamParse({
    filePath: 'map.osm.pbf',
    node: function(node) {
        console.log(`Node: ${node.id}`);
    },
    way: function(way) {
        console.log(`Way: ${way.id}`);
    },
    relation: function(relation) {
        console.log(`Relation: ${relation.id}`);
    }
});

// Control parser
parser.pause(); // Pause processing
parser.resume(); // Resume processing
parser.cleanup(); // Clean up resources
```

### Advanced Usage with Low-level Components

```javascript
const { CoreReader, DecompressParser } = require('osm-read-enhanced');

const coreParser = new CoreReader('map.osm.pbf', { verbose: true });
coreParser.on('headerBoundariesIdentified', (event) => {
    console.log('Found header:', event.headerDetails);
});
coreParser.parse();
```

## Key Improvements

- **Memory Efficiency**: Process huge files without memory issues
- **Error Handling**: Better recovery from malformed data
- **Performance**: Optimized parsing and data handling
- **Flexibility**: Choose the right parser for your use case
- **Clarity**: Well-documented code with consistent patterns

## API Reference

See the individual module documentation for complete API details.
