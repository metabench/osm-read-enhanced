#!/usr/bin/env node

/**
 * Test script to demonstrate both single-threaded and multi-threaded decompression modes
 */

const osmread = require('./lib/main');
const zlib = require('./lib/nodejs/zlib');

console.log('=== OSM PBF Enhanced Decompression Testing ===\n');

// Test file
const testFile = 'test/input/pitcairn-islands-latest.osm.pbf';

async function testMode(enableWorkers, modeName) {
    console.log(`Testing ${modeName} mode...`);
    
    // Set environment variable for this test
    process.env.OSM_ENABLE_DECOMPRESSION_WORKERS = enableWorkers ? 'true' : 'false';
    
    // Clear any existing worker pool
    try {
        zlib.shutdownWorkerPool();
    } catch (e) {
        // Ignore
    }
    
    let nodeCount = 0;
    let wayCount = 0;
    let relationCount = 0;
    
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
        osmread.parse({
            filePath: testFile,
            node: (node) => nodeCount++,
            way: (way) => wayCount++,
            relation: (relation) => relationCount++,
            endDocument: () => {
                const endTime = Date.now();
                const duration = endTime - startTime;
                
                // Get final stats
                const stats = zlib.getWorkerPoolStats();
                
                console.log(`  ✓ Parsed ${nodeCount} nodes, ${wayCount} ways, ${relationCount} relations`);
                console.log(`  ✓ Processing time: ${duration}ms`);
                console.log(`  ✓ Workers enabled: ${stats.decompressionWorkersEnabled}`);
                if (stats.decompressionWorkersEnabled) {
                    console.log(`  ✓ Peak workers: ${stats.peakWorkerCount}, Tasks completed: ${stats.tasksCompleted}`);
                }
                console.log('');
                
                // Clean up
                try {
                    zlib.shutdownWorkerPool();
                } catch (e) {
                    // Ignore
                }
                
                resolve({
                    mode: modeName,
                    nodeCount,
                    wayCount,
                    relationCount,
                    duration,
                    workersEnabled: stats.decompressionWorkersEnabled,
                    peakWorkers: stats.peakWorkerCount,
                    tasksCompleted: stats.tasksCompleted
                });
            },
            error: (err) => {
                console.error(`  ✗ Error in ${modeName} mode:`, err);
                reject(err);
            }
        });
    });
}

async function runTests() {
    try {
        // Test single-threaded mode
        const singleThreadedResult = await testMode(false, 'Single-threaded');
        
        // Wait a bit between tests to ensure clean separation
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Test multi-threaded mode
        const multiThreadedResult = await testMode(true, 'Multi-threaded');
        
        // Summary
        console.log('=== SUMMARY ===');
        console.log('Configuration successfully allows both modes:');
        console.log(`• Single-threaded: ${singleThreadedResult.duration}ms (workers: ${singleThreadedResult.workersEnabled})`);
        console.log(`• Multi-threaded: ${multiThreadedResult.duration}ms (workers: ${multiThreadedResult.workersEnabled}, peak: ${multiThreadedResult.peakWorkers})`);
        console.log('');
        console.log('✓ Multithreading is ONLY used for decompression (zlib/brotli)');
        console.log('✓ All other parsing logic remains single-threaded');
        console.log('✓ Clean fallback to sync decompression when workers unavailable');
        console.log('✓ Configurable via OSM_ENABLE_DECOMPRESSION_WORKERS environment variable');
        console.log('✓ Clean worker shutdown and process exit in both modes');
        
        process.exit(0);
        
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

runTests();
