const osmread = require('./lib/main');
const fs = require('fs');

/**
 * Planet PBF Parser Test
 * Reads through the full planet PBF file and logs progress every second
 */

// Configure decompression workers for high performance
// Set to 24 workers for maximum throughput on high-end systems
osmread.configureDecompressionWorkers({
    enabled: true,
    maxWorkers: 24,
    minWorkers: 4,
    optimalWorkers: 16,
    scalingMode: 'conservative' // Options: 'conservative', 'aggressive', 'fixed'
});

console.log('Configured decompression workers: 24 max workers with conservative scaling for high-performance parsing');

const planetPath = 'd:\\planet-250203.osm.pbf';

// Check if file exists
if (!fs.existsSync(planetPath)) {
    console.error(`Planet file not found: ${planetPath}`);
    process.exit(1);
}

console.log(`Starting to parse planet file: ${planetPath}`);
console.log(`File size: ${(fs.statSync(planetPath).size / 1024 / 1024 / 1024).toFixed(2)} GB`);

let startTime = Date.now();
let lastLogTime = Date.now();
let totalNodes = 0;
let totalWays = 0;
let totalRelations = 0;
let nodesLastSecond = 0;
let waysLastSecond = 0;
let relationsLastSecond = 0;
let bytesProcessed = 0;
let totalFileSize = fs.statSync(planetPath).size;
let parsingStarted = false;
let initializationPhase = "Starting";
let workerStatsLastReported = 0;

console.log(`[${new Date().toISOString()}] Initializing parser...`);

// Progress logging interval - starts immediately
const progressInterval = setInterval(() => {
    const currentTime = Date.now();
    const elapsedTotal = (currentTime - startTime) / 1000;
    
    if (!parsingStarted) {
        console.log(`[${new Date().toISOString()}] ${initializationPhase}... (${elapsedTotal.toFixed(1)}s elapsed)`);
    } else {
        const progressPercent = ((bytesProcessed / totalFileSize) * 100).toFixed(2);
        const mbPerSecond = ((bytesProcessed / 1024 / 1024) / elapsedTotal).toFixed(2);
        
        // Get enhanced worker pool stats every 5 seconds
        let workerStatsStr = '';
        if (elapsedTotal - workerStatsLastReported >= 5) {
            try {
                const stats = osmread.getWorkerPoolStats();
                const totalQueued = (stats.queuedTasks || 0) + (stats.priorityTasks || 0);
                const memPressure = stats.memoryPressure ? ` Mem:${(stats.memoryPressure * 100).toFixed(1)}%` : '';
                const efficiency = stats.workerEfficiency ? ` Eff:${stats.workerEfficiency.toFixed(1)}t/s` : '';
                const workersEnabled = stats.decompressionWorkersEnabled ? 'ENABLED' : 'DISABLED';
                workerStatsStr = ` | Decompression Workers: ${workersEnabled} (${stats.totalWorkers} total, ${stats.busyWorkers} busy, ${totalQueued} queued${memPressure}${efficiency})`;
                workerStatsLastReported = elapsedTotal;
            } catch (e) {
                // Stats not available
            }
        }
        
        console.log(`[${new Date().toISOString()}] Progress: ${progressPercent}% | ` +
                    `Speed: ${mbPerSecond} MB/s | ` +
                    `Total: ${totalNodes} nodes, ${totalWays} ways, ${totalRelations} relations | ` +
                    `Last second: +${nodesLastSecond} nodes, +${waysLastSecond} ways, +${relationsLastSecond} relations${workerStatsStr}`);
        
        // Reset counters for next second
        nodesLastSecond = 0;
        waysLastSecond = 0;
        relationsLastSecond = 0;
    }
    lastLogTime = currentTime;
}, 1000);

console.log(`[${new Date().toISOString()}] Calling osmread.parse()...`);
initializationPhase = "Opening file";

// Add immediate callback to confirm parser started
setTimeout(() => {
    if (!parsingStarted) {
        initializationPhase = "Reading file header";
    }
}, 100);

setTimeout(() => {
    if (!parsingStarted) {
        initializationPhase = "Processing file blocks";
    }
}, 500);

osmread.parse({
    filePath: planetPath,
    // verbose: true, // Disabled for better performance
    
    // Add callbacks to track initialization phases
    startDocument: function() {
        initializationPhase = "Document started";
        parsingStarted = true;
        console.log(`[${new Date().toISOString()}] Document parsing started!`);
    },
    
    node: function(node) {
        if (!parsingStarted) {
            parsingStarted = true;
            console.log(`[${new Date().toISOString()}] First node received - parsing active!`);
        }
        totalNodes++;
        nodesLastSecond++;
    },
    
    way: function(way) {
        if (!parsingStarted) {
            parsingStarted = true;
            console.log(`[${new Date().toISOString()}] First way received - parsing active!`);
        }
        totalWays++;
        waysLastSecond++;
    },
    
    relation: function(relation) {
        if (!parsingStarted) {
            parsingStarted = true;
            console.log(`[${new Date().toISOString()}] First relation received - parsing active!`);
        }
        totalRelations++;
        relationsLastSecond++;
    },
    
    // Track progress through file blocks
    found: function(event) {
        if (event.event === "foundFileBlock") {
            if (!parsingStarted) {
                initializationPhase = "Reading file blocks";
            }
            // Update bytes processed based on file block position
            bytesProcessed = event.globalOffset || 0;
        }
    },
    
    endDocument: function() {
        clearInterval(progressInterval);
        
        // Get final worker pool stats
        let finalWorkerStats = '';
        try {
            const stats = osmread.getWorkerPoolStats();
            finalWorkerStats = `\nDecompression Worker Pool Final Stats:
  Workers Enabled: ${stats.decompressionWorkersEnabled ? 'YES' : 'NO'}
  Peak Workers: ${stats.peakWorkerCount}
  Tasks Completed: ${stats.tasksCompleted.toLocaleString()}
  Avg Processing Time: ${stats.avgProcessingTime}ms
  Final Efficiency: ${stats.workerEfficiency} tasks/s
  Peak Memory Pressure: ${(stats.memoryPressure * 100).toFixed(1)}%`;
            osmread.shutdownWorkerPool(); // Clean shutdown
        } catch (e) {
            // Stats not available
        }
        
        const endTime = Date.now();
        const totalTime = (endTime - startTime) / 1000;
        const avgMbPerSecond = ((totalFileSize / 1024 / 1024) / totalTime).toFixed(2);
        
        console.log('\n=== PARSING COMPLETE ===');
        console.log(`Total time: ${totalTime.toFixed(2)} seconds`);
        console.log(`Average speed: ${avgMbPerSecond} MB/s`);
        console.log(`Total elements parsed:`);
        console.log(`  Nodes: ${totalNodes.toLocaleString()}`);
        console.log(`  Ways: ${totalWays.toLocaleString()}`);
        console.log(`  Relations: ${totalRelations.toLocaleString()}`);
        console.log(`  Total: ${(totalNodes + totalWays + totalRelations).toLocaleString()}`);
        console.log(finalWorkerStats);
        
        process.exit(0);
    },
    
    error: function(err) {
        clearInterval(progressInterval);
        console.error('Error parsing planet file:', err);
        process.exit(1);
    }
});

// Handle process termination
process.on('SIGINT', () => {
    clearInterval(progressInterval);
    console.log('\n\nParsing interrupted by user');
    console.log(`Processed ${totalNodes + totalWays + totalRelations} elements before interruption`);
    process.exit(0);
});

process.on('SIGTERM', () => {
    clearInterval(progressInterval);
    console.log('\n\nParsing terminated');
    process.exit(0);
});