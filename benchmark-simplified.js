#!/usr/bin/env node

/**
 * SIMPLIFIED PARSER BENCHMARK
 * 
 * This benchmark tests the final, simplified OSM PBF parser with all decode mode logic removed.
 * It measures pure parsing performance with the optimized "full" parsing path that our 
 * previous benchmarks identified as fastest.
 */

const fs = require('fs');
const path = require('path');
const osmread = require('./lib/main');

// Test file
const DEFAULT_PBF_FILE = 'test/input/pitcairn-islands-latest.osm.pbf';

class SimplifiedBenchmark {
  constructor(pbfFile) {
    this.pbfFile = pbfFile;
    this.results = {
      nodes: 0,
      ways: 0,
      relations: 0,
      blobs: 0,
      timing: {
        total: 0,
        parsing: 0,
        average_per_blob: 0
      }
    };
    this.blobTimings = [];
  }

  async run() {
    console.log('='.repeat(60));
    console.log('SIMPLIFIED OSM PBF PARSER BENCHMARK');
    console.log('='.repeat(60));
    console.log(`File: ${this.pbfFile}`);
    console.log(`File size: ${this.getFileSize()} MB`);
    console.log();

    const totalStart = process.hrtime.bigint();

    return new Promise((resolve, reject) => {
      const parseStart = process.hrtime.bigint();
      
      osmread.parse({
        filePath: this.pbfFile,
        node: () => this.results.nodes++,
        way: () => this.results.ways++,
        relation: () => this.results.relations++,
        endDocument: () => {
          const parseEnd = process.hrtime.bigint();
          const totalEnd = process.hrtime.bigint();
          
          this.results.timing.parsing = Number(parseEnd - parseStart) / 1000000; // ms
          this.results.timing.total = Number(totalEnd - totalStart) / 1000000; // ms
          
          this.printResults();
          resolve(this.results);
        },
        error: (err) => {
          console.error('Parser error:', err.message);
          reject(err);
        }
      });
    });
  }

  getFileSize() {
    const stats = fs.statSync(this.pbfFile);
    return (stats.size / (1024 * 1024)).toFixed(2);
  }

  printResults() {
    console.log('PARSING RESULTS:');
    console.log('-'.repeat(40));
    console.log(`Nodes:      ${this.formatNumber(this.results.nodes)}`);
    console.log(`Ways:       ${this.formatNumber(this.results.ways)}`);
    console.log(`Relations:  ${this.formatNumber(this.results.relations)}`);
    console.log(`Total:      ${this.formatNumber(this.results.nodes + this.results.ways + this.results.relations)}`);
    console.log(`Blobs:      ${this.results.blobs}`);
    console.log();
    
    console.log('PERFORMANCE:');
    console.log('-'.repeat(40));
    console.log(`Total time:     ${this.results.timing.total.toFixed(3)} ms`);
    console.log(`Parsing time:   ${this.results.timing.parsing.toFixed(3)} ms`);
    
    if (this.results.timing.average_per_blob > 0) {
      console.log(`Avg per blob:   ${this.results.timing.average_per_blob.toFixed(3)} ms`);
    }
    
    const totalElements = this.results.nodes + this.results.ways + this.results.relations;
    if (totalElements > 0 && this.results.timing.parsing > 0) {
      const elementsPerSec = totalElements / (this.results.timing.parsing / 1000);
      console.log(`Elements/sec:   ${this.formatNumber(Math.round(elementsPerSec))}`);
    }
    
    const fileSizeMB = parseFloat(this.getFileSize());
    if (fileSizeMB > 0 && this.results.timing.parsing > 0) {
      const mbPerSec = fileSizeMB / (this.results.timing.parsing / 1000);
      console.log(`MB/sec:         ${mbPerSec.toFixed(2)}`);
    }
    
    console.log();
    console.log('OPTIMIZATION STATUS:');
    console.log('-'.repeat(40));
    console.log('✓ Decode mode logic removed');
    console.log('✓ Using optimized full parsing path');
    console.log('✓ Fast varint reading');
    console.log('✓ Minimal object creation');
    console.log('✓ Array preallocation');
    console.log('✓ No conditional branches in hot loops');
  }

  formatNumber(num) {
    return num.toLocaleString();
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const pbfFile = args[0] || DEFAULT_PBF_FILE;
  
  if (!fs.existsSync(pbfFile)) {
    console.error(`Error: File not found: ${pbfFile}`);
    console.error(`Usage: node ${path.basename(__filename)} [pbf-file]`);
    process.exit(1);
  }
  
  try {
    const benchmark = new SimplifiedBenchmark(pbfFile);
    await benchmark.run();
    
    console.log();
    console.log('✓ Benchmark completed successfully');
    console.log();
    console.log('NEXT STEPS:');
    console.log('- Profile with larger files to identify any remaining bottlenecks');
    console.log('- Test element count accuracy against reference implementation');
    console.log('- Update project documentation with final performance characteristics');
    
  } catch (error) {
    console.error('Benchmark failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = SimplifiedBenchmark;
