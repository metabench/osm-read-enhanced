const osmread = require('./lib/main');
const fs = require('fs');

/**
 * Worker Scaling Test
 * Tests the OSM PBF parser with different numbers of decompression workers
 */

const testFile = './test/input/pitcairn-islands-latest.osm.pbf';

if (!fs.existsSync(testFile)) {
    console.error(`Test file not found: ${testFile}`);
    process.exit(1);
}

console.log(`Testing worker scaling with file: ${testFile}`);
console.log(`File size: ${(fs.statSync(testFile).size / 1024).toFixed(2)} KB`);

async function testWithWorkerCount(workerCount, testName) {
    console.log(`\n=== ${testName} ===`);
    
    // Configure workers
    osmread.configureDecompressionWorkers({
        enabled: workerCount > 0,
        maxWorkers: workerCount,
        minWorkers: Math.min(2, workerCount),
        optimalWorkers: Math.min(Math.floor(workerCount * 0.7), workerCount)
    });
    
    console.log(`Configured: ${workerCount > 0 ? workerCount + ' workers' : 'single-threaded mode'}`);
    
    return new Promise((resolve, reject) => {
        let nodeCount = 0;
        let wayCount = 0;
        let relationCount = 0;
        
        const startTime = Date.now();
        
        const parser = osmread.createPbfParser();
        
        parser.on('node', (node) => {
            nodeCount++;
        });
        
        parser.on('way', (way) => {
            wayCount++;
        });
        
        parser.on('relation', (relation) => {
            relationCount++;
        });
        
        parser.on('end', () => {
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            // Get final stats
            try {
                const stats = osmread.getWorkerPoolStats();
                console.log(`Results: ${nodeCount} nodes, ${wayCount} ways, ${relationCount} relations in ${duration}ms`);
                console.log(`Worker stats: ${stats.totalWorkers} total, ${stats.tasksCompleted} tasks completed`);
                console.log(`Performance: ${(nodeCount / duration * 1000).toFixed(0)} nodes/sec`);
                
                // Shutdown workers
                osmread.shutdownWorkerPool();
            } catch (e) {
                console.log(`Results: ${nodeCount} nodes, ${wayCount} ways, ${relationCount} relations in ${duration}ms`);
                console.log(`Performance: ${(nodeCount / duration * 1000).toFixed(0)} nodes/sec`);
            }
            
            resolve({
                nodeCount,
                wayCount,
                relationCount,
                duration,
                nodesPerSecond: nodeCount / duration * 1000
            });
        });
        
        parser.on('error', (error) => {
            console.error('Parser error:', error);
            reject(error);
        });
        
        // Parse the file
        osmread.parsePbf({
            filePath: testFile,
            parser: parser
        });
    });
}

async function runTests() {
    const testConfigs = [
        { workers: 0, name: "Single-threaded (baseline)" },
        { workers: 1, name: "1 Worker" },
        { workers: 2, name: "2 Workers" },
        { workers: 4, name: "4 Workers" },
        { workers: 8, name: "8 Workers" },
        { workers: 16, name: "16 Workers" },
        { workers: 24, name: "24 Workers (high-end config)" }
    ];
    
    const results = [];
    
    for (const config of testConfigs) {
        try {
            const result = await testWithWorkerCount(config.workers, config.name);
            results.push({
                ...result,
                workerCount: config.workers,
                testName: config.name
            });
            
            // Small delay between tests
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error(`Test failed for ${config.name}:`, error);
        }
    }
    
    // Summary
    console.log('\n=== SCALING TEST SUMMARY ===');
    console.log('Worker Count | Performance (nodes/sec) | Duration (ms) | Speedup');
    console.log('-------------|------------------------|---------------|--------');
    
    const baseline = results.find(r => r.workerCount === 0);
    const baselinePerf = baseline ? baseline.nodesPerSecond : 1;
    
    for (const result of results) {
        const speedup = (result.nodesPerSecond / baselinePerf).toFixed(2);
        console.log(`${result.workerCount.toString().padStart(11)} | ${result.nodesPerSecond.toFixed(0).padStart(21)} | ${result.duration.toString().padStart(12)} | ${speedup.padStart(6)}x`);
    }
    
    console.log('\nScaling test complete!');
    process.exit(0);
}

runTests().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
});
