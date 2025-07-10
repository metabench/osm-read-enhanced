/*
OSM PBF Decompressor Module:
- Extends the core parser which now emits complete "blob" events.
- Listens for these "blob" events and decompresses the blob if needed.
- Uses single-threaded decompression via zlib.
- Emits "blob-decompressed" events once processing is complete.
*/
const zlib = require('zlib');
const OSM_PBF_Parser_Core_Read = require('./OSM_PBF_Parser_Core_Read.js');

class OSM_PBF_Parser_Decompress extends OSM_PBF_Parser_Core_Read {
	// Simply set up any needed options and pass them to the core parser.
	constructor(file_path, options = {}) {
		options.suppressConsoleOutput = true;
		super(file_path, options);
		this.verbose = options.verbose || false;
	}
  
	// Set up a handler that listens for complete "blob" events.
	_setupDecompressionHandler() {
		this.on('blob', (event) => {
			const { blobData, blobIndex, input_chunk_index, globalDataStart } = event;
			// Check if the blob looks like compressed data.
			let decompressor;
			if (blobData.length >= 2 && blobData[0] === 0x78 &&
					(blobData[1] === 0x01 || blobData[1] === 0x9C || blobData[1] === 0xDA)) {
				decompressor = zlib.createInflate();
			} else if (blobData.length >= 2 && blobData[0] === 0x1F && blobData[1] === 0x8B) {
				decompressor = zlib.createGunzip();
			}
      
			if (decompressor) {
				const chunks = [];
				decompressor.on('data', (chunk) => {
					chunks.push(chunk);
				});
				decompressor.on('end', () => {
					const decompressedData = Buffer.concat(chunks);
					this.raise('blob-decompressed', {
						blobIndex,
						decompressedData,
						length: decompressedData.length,
						input_chunk_index,
						globalDataStart
					});
				});
				decompressor.on('error', (err) => {
					this.raise('error', new Error(`Decompression error in blob ${blobIndex}: ${err.message}`));
				});
				decompressor.end(blobData);
			} else {
				// Not compressed: forward the data as is.
				this.raise('blob-decompressed', {
					blobIndex,
					decompressedData: blobData,
					length: blobData.length,
					input_chunk_index,
					globalDataStart
				});
			}
		});
	}
  
	// Override parse() so that we first attach our decompression handler.
	parse() {
		this._setupDecompressionHandler();
		super.parse();
	}
}

module.exports = OSM_PBF_Parser_Decompress;

if (require.main === module) {
	const pbf_path = process.argv[2] || "D:\\planet-250203.osm.pbf";
	const parser = new OSM_PBF_Parser_Decompress(pbf_path, { verbose: true, highWaterMark: 4 * 1024 * 1024 });
  
	parser.on('start', (event) => {
		console.log(`Started reading ${event.file_path} (size: ${event.file_size} bytes)...`);
	});
  

  let ld = 0;

	parser.on('blob-decompressed', (event) => {
		//console.log(`Blob ${event.blobIndex} decompressed: ${event.length} bytes`);
    ld += event.length;
	});
  
	parser.on('end', (event) => {
		console.log(`Completed parsing. Total time: ${event.elapsed ? event.elapsed.toFixed(1) : 'N/A'}s`);
    console.log(`Total decompressed data: ${ld} bytes`);
	});
  
	parser.on('error', (err) => {
		console.error(`Error: ${err.message}`);
	});
  
	parser.parse();
}