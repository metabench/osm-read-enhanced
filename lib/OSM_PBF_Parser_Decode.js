/*
OSM_PBF_Parser_Decode:
• Extends OSM_PBF_Parser_Decompress.
• Listens for 'blob-decompressed' events.
• For each decompressed blob, creates an OSM_Blob instance (using the decompressed data and blob index).
• Raises a 'blob-ready' event carrying the new OSM_Blob instance.
• Blob limiting (e.g. maxBlobLimit) is handled entirely within the Core_Read class.
• Includes simple driver code for standalone execution.
*/
const OSM_PBF_Parser_Decompress = require('./OSM_PBF_Parser_Decompress.js');
const OSM_Blob = require('./OSM_Blob.js');

class OSM_PBF_Parser_Decode extends OSM_PBF_Parser_Decompress {
  constructor(file_path, options = {}) {
    super(file_path, options);
    // Note: The maxBlobLimit option is handled in the Core_Read class.
    this.on('blob-decompressed', (event) => {
      try {
        const blobInstance = new OSM_Blob({
          index: event.blobIndex,
          data: event.decompressedData
        });
        this.raise('blob-ready', {
          blob: blobInstance,
          blobIndex: event.blobIndex,
          input_chunk_index: event.input_chunk_index,
          globalDataStart: event.globalDataStart
        });
      } catch (err) {
        this.raise('error', new Error(`Error encapsulating blob ${event.blobIndex}: ${err.message}`));
      }
    });
  }
  
  // Use the decompression chain's parse() method.
  parse() {
    super.parse();
  }
}

module.exports = OSM_PBF_Parser_Decode;

// Driver code for standalone execution
if (require.main === module) {
  const filePath = process.argv[2] || "D:\\planet-250203.osm.pbf";
  const parser = new OSM_PBF_Parser_Decode(filePath, { 
    verbose: true, 
    highWaterMark: 4 * 1024 * 1024,
    maxBlobLimit: 5 // This option is passed to the Core_Read class.
  });
  
  parser.on('start', (event) => {
    console.log(`Started reading ${event.file_path} (size: ${event.file_size} bytes)...`);
  });
  
  parser.on('blob-ready', (event) => {
    // For example, print the blob index and the number of strings in its stringtable.
    const count = [...event.blob.iterate_stringtable()].length;
    console.log(`Blob-ready: Blob ${event.blobIndex} encapsulated, stringtable count: ${count}`);
  });
  
  parser.on('end', (event) => {
    console.log(`Completed parsing. Total time: ${event.elapsed ? event.elapsed.toFixed(1) : 'N/A'} seconds`);
  });
  
  parser.on('error', (err) => {
    console.error("Error:", err.message);
  });
  
  parser.parse();
}
