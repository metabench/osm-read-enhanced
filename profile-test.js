// Simple timing test for OSM_PBF_Parser_Decode
const OSM_PBF_Parser_Decode = require('./lib/OSM_PBF_Parser_Decode.js');

console.log('🔬 PERFORMANCE PROFILING TEST');
console.log('═'.repeat(50));

const parser = new OSM_PBF_Parser_Decode('test/test.pbf', { 
  verbose: false, 
  maxBlobLimit: 2 
});

let blobCount = 0;
const overallStart = process.hrtime.bigint();

parser.on('start', (event) => {
  console.log(`📁 Started parsing: ${event.file_path} (${event.file_size} bytes)`);
});

parser.on('blob-ready', (event) => {
  const blobStart = process.hrtime.bigint();
  blobCount++;
  const blob = event.blob;
  const blobType = event.blobType || 'unknown';
  
  console.log(`\n📦 BLOB ${event.blobIndex} (${blobType}, ${blob.buffer.length} bytes)`);
  
  if (blobType === 'OSMData') {
    // Test string count timing
    const stringStart = process.hrtime.bigint();
    const stringCount = blob.getStringCount();
    const stringTime = process.hrtime.bigint() - stringStart;
    console.log(`   🔤 String count: ${stringCount} (${Number(stringTime) / 1000000}ms)`);
    
    // Test node counting timing
    const nodeStart = process.hrtime.bigint();
    let nodeCount = 0;
    try {
      for (const node of blob.iterateNodes()) {
        nodeCount++;
        if (nodeCount >= 100) break; // Small limit for testing
      }
    } catch (e) {
      console.log(`   📍 Node iteration error: ${e.message}`);
    }
    const nodeTime = process.hrtime.bigint() - nodeStart;
    console.log(`   📍 Nodes: ${nodeCount} (${Number(nodeTime) / 1000000}ms)`);
    
    // Test way counting timing
    const wayStart = process.hrtime.bigint();
    let wayCount = 0;
    try {
      for (const way of blob.iterateWays()) {
        wayCount++;
        if (wayCount >= 50) break; // Small limit for testing
      }
    } catch (e) {
      console.log(`   🛣️  Way iteration error: ${e.message}`);
    }
    const wayTime = process.hrtime.bigint() - wayStart;
    console.log(`   🛣️  Ways: ${wayCount} (${Number(wayTime) / 1000000}ms)`);
  }
  
  const blobTime = process.hrtime.bigint() - blobStart;
  console.log(`   ⏱️  Total blob time: ${Number(blobTime) / 1000000}ms`);
});

parser.on('end', (event) => {
  const overallTime = process.hrtime.bigint() - overallStart;
  console.log(`\n🏁 COMPLETED: ${blobCount} blobs in ${Number(overallTime) / 1000000}ms`);
  console.log(`   ⚡ Overall rate: ${Number(overallTime) / 1000000 / blobCount}ms per blob`);
});

parser.on('error', (err) => {
  console.error('❌ Error:', err.message);
});

parser.parse();
