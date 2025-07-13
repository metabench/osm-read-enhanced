const OSM_PBF_Parser_Decode = require('./lib/OSM_PBF_Parser_Decode.js');

// Test 1: Default 24GB threshold
console.log('Test 1: Default threshold');
const parser1 = new OSM_PBF_Parser_Decode('test.pbf');
console.log(`Default threshold: ${parser1.read_threshold / (1024 * 1024 * 1024)}GB`);

// Test 2: Custom threshold (1GB)
console.log('\nTest 2: Custom 1GB threshold');
const parser2 = new OSM_PBF_Parser_Decode('test.pbf', { read_threshold: 1 * 1024 * 1024 * 1024 });
console.log(`Custom threshold: ${parser2.read_threshold / (1024 * 1024 * 1024)}GB`);

// Test 3: Null threshold (no limit)
console.log('\nTest 3: No threshold (null)');
const parser3 = new OSM_PBF_Parser_Decode('test.pbf', { read_threshold: null });
console.log(`No threshold: ${parser3.read_threshold}`);

// Test 4: Zero threshold
console.log('\nTest 4: Zero threshold');
const parser4 = new OSM_PBF_Parser_Decode('test.pbf', { read_threshold: 0 });
console.log(`Zero threshold: ${parser4.read_threshold}GB`);

console.log('\n✅ All threshold tests completed successfully!');
