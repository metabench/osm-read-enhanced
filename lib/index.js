/**
 * Main entry point for the osm-read-enhanced library
 * Exports all parser variants for different use cases
 */

// Import parsers
const ClassicParser = require('./pbfParser');
const StreamParser = require('./pbf-stream-parser');
const CoreReader = require('./OSM_PBF_Parser_Core_read');
const DecompressParser = require('./OSM_PBF_Parser_Decompress');

// Export all parsers
module.exports = {
    // Classic parser for backward compatibility
    parse: ClassicParser.parse,
    createParser: ClassicParser.createParser,
    
    // New streaming parser
    streamParse: function(opts) {
        const parser = new StreamParser(opts);
        return parser.parse();
    },
    
    // Individual components for advanced usage
    CoreReader,
    DecompressParser,
    StreamParser
};

// Add driver code to test basic functionality
if (require.main === module) {
    console.log("osm-read-enhanced library");
    console.log("Available parsers:");
    console.log("- Classic: parse(), createParser()");
    console.log("- Streaming: streamParse()");
    console.log("- Advanced components: CoreReader, DecompressParser, StreamParser");
    console.log("\nTo use a parser, run its own module directly or import this library programmatically.");
}
