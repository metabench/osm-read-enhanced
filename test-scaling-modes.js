const osmread = require('./lib/main');
const fs = require('fs');

/**
 * Scaling Mode Test
 * Demonstrates different decompression worker scaling behaviors
 */

const testFile = './test/input/pitcairn-islands-latest.osm.pbf';

if (!fs.existsSync(testFile)) {
    console.error(`Test file not found: ${testFile}`);
    process.exit(1);
}

console.log(`Testing scaling modes with file: ${testFile}`);

async function testScalingMode(mode, description) {
    console.log(`\n=== Testing ${mode.toUpperCase()} Scaling Mode ===`);
    console.log(`Description: ${description}`);
    
    // Configure workers with the specific scaling mode
    osmread.configureDecompressionWorkers({
        enabled: true,
        maxWorkers: 12,
        minWorkers: 2,
        optimalWorkers: 6,
        scalingMode: mode
    });
    
    return new Promise((resolve, reject) => {
        let nodeCount = 0;
        let wayCount = 0;
        let relationCount = 0;
        
        const startTime = Date.now();
        let maxWorkers = 0;
        let finalStats = null;
        
        // Monitor worker stats during parsing
        const statsInterval = setInterval(() => {
            try {
                const stats = osmread.getWorkerPoolStats();
                maxWorkers = Math.max(maxWorkers, stats.totalWorkers);
                console.log(`  Workers: ${stats.totalWorkers} total, ${stats.busyWorkers} busy, ${stats.queuedTasks + stats.priorityTasks} queued`);
            } catch (e) {
                // Stats not available
            }
        }, 1000);
        
        osmread.parse({
            filePath: testFile,
            
            node: (node) => {
                nodeCount++;
            },
            
            way: (way) => {
                wayCount++;
            },
            
            relation: (relation) => {
                relationCount++;
            },
            
            endDocument: () => {
                clearInterval(statsInterval);
                
                const endTime = Date.now();
                const duration = endTime - startTime;
                
                // Get final stats
                try {
                    finalStats = osmread.getWorkerPoolStats();
                    osmread.shutdownWorkerPool();
                } catch (e) {
                    // Stats not available
                }
                
                console.log(`Results:`);
                console.log(`  Duration: ${duration}ms`);
                console.log(`  Elements: ${nodeCount} nodes, ${wayCount} ways, ${relationCount} relations`);
                console.log(`  Performance: ${(nodeCount / duration * 1000).toFixed(0)} nodes/sec`);
                console.log(`  Max workers used: ${maxWorkers}`);
                if (finalStats) {
                    console.log(`  Tasks completed: ${finalStats.tasksCompleted}`);
                    console.log(`  Peak worker count: ${finalStats.peakWorkerCount}`);
                }
                
                resolve({
                    mode,
                    nodeCount,
                    wayCount,
                    relationCount,
                    duration,
                    maxWorkers,
                    peakWorkers: finalStats ? finalStats.peakWorkerCount : maxWorkers,
                    tasksCompleted: finalStats ? finalStats.tasksCompleted : 0
                });
            },
            
            error: (error) => {
                clearInterval(statsInterval);
                console.error('Parser error:', error);
                reject(error);
            }
        });
    });
}

async function runScalingTests() {
    const scalingModes = [
        { 
            mode: 'fixed', 
            description: 'Never auto-scales workers beyond minimum' 
        },
        { 
            mode: 'conservative', 
            description: 'Only scales up when significant queue backlog (3+ tasks)' 
        },
        { 
            mode: 'aggressive', 
            description: 'Scales up quickly on any backlog, proactively to optimal count' 
        }
    ];
    
    const results = [];
    
    for (const config of scalingModes) {
        try {
            const result = await testScalingMode(config.mode, config.description);
            results.push(result);
            
            // Small delay between tests
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error(`Test failed for ${config.mode} mode:`, error);
        }
    }
    
    // Summary comparison
    console.log('\n=== SCALING MODE COMPARISON ===');
    console.log('Mode         | Duration (ms) | Max Workers | Tasks | Performance (nodes/sec)');
    console.log('-------------|---------------|-------------|-------|------------------------');
    
    for (const result of results) {
        const performance = (result.nodeCount / result.duration * 1000).toFixed(0);
        console.log(`${result.mode.padEnd(12)} | ${result.duration.toString().padStart(12)} | ${result.maxWorkers.toString().padStart(10)} | ${result.tasksCompleted.toString().padStart(5)} | ${performance.padStart(22)}`);
    }
    
    console.log('\nKey observations:');
    console.log('- FIXED: Uses minimum workers only, may have slower performance but very predictable');
    console.log('- CONSERVATIVE: Balanced approach, scales up only when needed');
    console.log('- AGGRESSIVE: Uses more workers quickly, may have higher overhead but potentially better throughput');
    console.log('\nChoose based on your system resources and performance requirements.');
    
    process.exit(0);
}

runScalingTests().catch(error => {
    console.error('Scaling test suite failed:', error);
    process.exit(1);
});
