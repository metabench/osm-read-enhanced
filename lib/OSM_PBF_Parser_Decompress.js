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
  
	// Helper method to parse a Blob protobuf message
	// Returns an object with fields: raw, zlib_data, lzma_data, bzip2_data, raw_size
	_parseBlobMessage(blobBuffer) {
		const result = {};
		let offset = 0;
		
		while (offset < blobBuffer.length) {
			// Read the field tag
			const keyInfo = this._readVarint(blobBuffer, offset);
			const key = keyInfo.value;
			offset += keyInfo.bytesRead;
			
			const fieldNumber = key >> 3;
			const wireType = key & 0x07;
			
			if (wireType === 2) { // Length-delimited (bytes)
				const lenInfo = this._readVarint(blobBuffer, offset);
				const dataLength = lenInfo.value;
				offset += lenInfo.bytesRead;
				
				const data = blobBuffer.slice(offset, offset + dataLength);
				offset += dataLength;
				
				switch (fieldNumber) {
					case 1: // raw
						result.raw = data;
						break;
					case 3: // zlib_data
						result.zlib_data = data;
						break;
					case 4: // lzma_data
						result.lzma_data = data;
						break;
					case 5: // bzip2_data
						result.bzip2_data = data;
						break;
					default:
						// Skip unknown fields
						break;
				}
			} else if (wireType === 0) { // Varint
				const varintInfo = this._readVarint(blobBuffer, offset);
				offset += varintInfo.bytesRead;
				
				if (fieldNumber === 2) { // raw_size
					result.raw_size = varintInfo.value;
				}
				// Skip other varint fields
			} else {
				// Skip unknown wire types
				throw new Error(`Unknown wire type ${wireType} in Blob message at offset ${offset}`);
			}
		}
		
		return result;
	}
	
	// Helper method to read a varint from a buffer
	_readVarint(buffer, offset) {
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
  
	// Set up a handler that listens for complete "blob" events.
	_setupDecompressionHandler() {
		this.on('blob', (event) => {
			const { blobData, blobIndex, input_chunk_index, globalDataStart, headerDetails } = event;
			const blobType = headerDetails ? headerDetails.type : 'unknown';
			
			if (this.verbose) {
				console.log(`Processing blob ${blobIndex} (type: ${blobType}, size: ${blobData.length} bytes)`);
			}
			
			try {
				// Parse the Blob protobuf message to extract the actual data
				const blobContent = this._parseBlobMessage(blobData);
				
				if (blobContent.raw) {
					// Data is not compressed, use as-is
					if (this.verbose) {
						console.log(`Blob ${blobIndex}: Using raw data (${blobContent.raw.length} bytes)`);
					}
					this.raise('blob-decompressed', {
						blobIndex,
						decompressedData: blobContent.raw,
						length: blobContent.raw.length,
						input_chunk_index,
						globalDataStart,
						blobType
					});
				} else if (blobContent.zlib_data) {
					// Data is zlib compressed, decompress it
					if (this.verbose) {
						console.log(`Blob ${blobIndex}: Decompressing zlib data (${blobContent.zlib_data.length} bytes compressed)`);
					}
					zlib.inflate(blobContent.zlib_data, (err, decompressedData) => {
						if (err) {
							this.raise('error', new Error(`Zlib decompression error for blob ${blobIndex}: ${err.message}`));
							return;
						}
						if (this.verbose) {
							console.log(`Blob ${blobIndex}: Decompressed to ${decompressedData.length} bytes`);
						}
						this.raise('blob-decompressed', {
							blobIndex,
							decompressedData,
							length: decompressedData.length,
							input_chunk_index,
							globalDataStart,
							blobType
						});
					});
				} else if (blobContent.lzma_data || blobContent.bzip2_data) {
					// Other compression formats are rarely used in OSM PBF files
					this.raise('error', new Error(`Unsupported compression format in blob ${blobIndex}`));
				} else {
					this.raise('error', new Error(`Blob ${blobIndex} contains no recognized data field. Available fields: ${Object.keys(blobContent).join(', ')}`));
				}
			} catch (err) {
				this.raise('error', new Error(`Error parsing blob ${blobIndex}: ${err.message}`));
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
		console.log(`Blob ${event.blobIndex} decompressed: ${event.length} bytes`);
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