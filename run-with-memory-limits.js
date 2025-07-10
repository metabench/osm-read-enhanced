#!/usr/bin/env node
/**
 * Memory-optimized runner script for OSM PBF Parser
 */
const path = require('path');
const { spawnSync } = require('child_process');

// Get command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node run-with-memory-limits.js <pbf-file> [memory-limit-mb] [options]');
  process.exit(1);
}

const pbfFile = args[0];
const memoryLimitMB = parseInt(args[1], 10) || 2048; // Default to 2GB
const otherArgs = args.slice(2);

// Build Node.js arguments with memory limits
const nodeArgs = [
  `--max-old-space-size=${memoryLimitMB}`,
  '--expose-gc',
  // Add other useful V8 flags
  '--optimize-for-size', // Optimize for memory rather than speed
  '--always-compact', // Always compact memory during garbage collection
  path.join(__dirname, 'process-pbf.js'),
  pbfFile,
  ...otherArgs
];

console.log(`Running with memory limit: ${memoryLimitMB}MB`);
console.log(`Node.js flags: ${nodeArgs.slice(0, 4).join(' ')}`);
console.log(`PBF file: ${pbfFile}`);

// Run the process with the specified memory limits
const result = spawnSync('node', nodeArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    OSM_PARSER_MEMORY_LIMIT: memoryLimitMB * 1024 * 1024
  }
});

if (result.error) {
  console.error('Error running process:', result.error);
  process.exit(1);
}

process.exit(result.status);
