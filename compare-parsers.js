#!/usr/bin/env node

/**
 * OSM PBF Parser Comparison Tool
 * ===============================
 * 
 * This script compares output from our custom OSM_Blob parser with the reference
 * protobuf-based pbfParser to validate correctness and identify discrepancies.
 * 
 * Features:
 * - Side-by-side comparison of blob structure
 * - Detailed stringtable analysis and comparison
 * - Sample data extraction from both parsers
 * - Raw protobuf structure analysis
 * - Error detection and reporting
 * - Performance metrics
 * 
 * Usage: node compare-parsers.js [pbf-file]
 */

const fs = require('fs');
const path = require('path');

// Import our custom parser components
const OSM_PBF_Parser_Decode = require('./lib/OSM_PBF_Parser_Decode.js');
const OSM_Blob = require('./lib/OSM_Blob.js');

// Import reference parser
const pbfParser = require('./lib/pbfParser.js');

class ParserComparator {
    constructor(options = {}) {
        this.options = {
            maxBlobs: options.maxBlobs || 10,
            verbose: options.verbose !== false,
            showRawStructure: options.showRawStructure || false,
            maxSampleNodes: options.maxSampleNodes || 5,
            maxSampleWays: options.maxSampleWays || 3,
            maxSampleRelations: options.maxSampleRelations || 2,
            ...options
        };
        
        this.stats = {
            customParser: {
                blobsProcessed: 0,
                errors: 0,
                warnings: 0,
                totalNodes: 0,
                totalWays: 0,
                totalRelations: 0
            },
            referenceParser: {
                blobsProcessed: 0,
                errors: 0,
                warnings: 0,
                totalNodes: 0,
                totalWays: 0,
                totalRelations: 0
            },
            discrepancies: []
        };
        
        this.customBlobData = [];
        this.referenceBlobData = [];
    }

    async compare(filePath) {
        console.log('🔍 OSM PBF Parser Comparison Tool');
        console.log('==================================\n');
        console.log(`📁 File: ${filePath}`);
        console.log(`⚙️  Max blobs: ${this.options.maxBlobs}`);
        console.log(`🔧 Verbose: ${this.options.verbose}\n`);

        try {
            // Run both parsers
            console.log('🚀 Running custom parser...');
            await this.runCustomParser(filePath);
            
            console.log('\n🚀 Running reference parser...');
            await this.runReferenceParser(filePath);
            
            console.log('\n📊 Comparing results...');
            this.compareResults();
            
            console.log('\n📈 Final Report');
            this.printFinalReport();
            
        } catch (error) {
            console.error('❌ Comparison failed:', error.message);
            if (this.options.verbose) {
                console.error(error.stack);
            }
        }
    }

    async runCustomParser(filePath) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let blobIndex = 0;
            
            const parser = new OSM_PBF_Parser_Decode(filePath, {
                maxBlobLimit: this.options.maxBlobs,
                verbose: false
            });
            
            // Set up event handlers
            parser.on('blob-ready', (event) => {
                const { blob, blobIndex: eventBlobIndex, blobType } = event;
                
                if (eventBlobIndex >= this.options.maxBlobs) {
                    return; // Skip processing if we've reached the limit
                }
                
                try {
                    this.stats.customParser.blobsProcessed++;
                    
                    if (blobType === 'OSMData') {
                        try {
                            const blobAnalysis = this.analyzeCustomBlob(blob, eventBlobIndex);
                            this.customBlobData.push(blobAnalysis);
                            
                            if (this.options.verbose) {
                                console.log(`✅ Custom blob ${eventBlobIndex}: ${blobAnalysis.summary}`);
                            }
                        } catch (blobError) {
                            console.error(`❌ Custom blob ${eventBlobIndex} analysis error:`, blobError.message);
                            this.stats.customParser.errors++;
                        }
                    }
                    
                    blobIndex = Math.max(blobIndex, eventBlobIndex + 1);
                    if (blobIndex >= this.options.maxBlobs) {
                        const duration = Date.now() - startTime;
                        console.log(`⏱️  Custom parser completed in ${duration}ms`);
                        resolve();
                    }
                    
                } catch (error) {
                    console.error(`❌ Custom parser blob ${eventBlobIndex} error:`, error.message);
                    this.stats.customParser.errors++;
                    blobIndex++;
                }
            });
            
            parser.on('error', (error) => {
                console.error('❌ Custom parser error:', error.message);
                reject(error);
            });
            
            parser.on('end', () => {
                const duration = Date.now() - startTime;
                console.log(`⏱️  Custom parser completed in ${duration}ms (${blobIndex} blobs total)`);
                resolve();
            });
            
            // Start reading
            parser.parse();
        });
    }

    async runReferenceParser(filePath) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let blobIndex = 0;
            let currentBlobData = null;
            
            const parseOptions = {
                filePath: filePath,
                verbose: false,
                callback: (error) => {
                    if (error) {
                        reject(error);
                    }
                },
                error: (error) => {
                    console.error('❌ Reference parser error:', error.message);
                    reject(error);
                },
                endDocument: () => {
                    const duration = Date.now() - startTime;
                    console.log(`⏱️  Reference parser completed in ${duration}ms`);
                    resolve();
                },
                found: (item) => {
                    if (item.event === 'foundFileBlock' && item.globalOffset !== undefined) {
                        // Start a new blob
                        currentBlobData = {
                            blobIndex: blobIndex,
                            nodes: { count: 0, samples: [] },
                            ways: { count: 0, samples: [] },
                            relations: { count: 0, samples: [] }
                        };
                        this.referenceBlobData[blobIndex] = currentBlobData;
                        blobIndex++;
                        this.stats.referenceParser.blobsProcessed++;
                    }
                },
                node: (node) => {
                    if (currentBlobData && blobIndex <= this.options.maxBlobs) {
                        currentBlobData.nodes.count++;
                        this.stats.referenceParser.totalNodes++;
                        
                        if (currentBlobData.nodes.samples.length < this.options.maxSampleNodes) {
                            currentBlobData.nodes.samples.push({
                                id: node.id,
                                lat: node.lat,
                                lon: node.lon,
                                tags: node.tags || {}
                            });
                        }
                    }
                },
                way: (way) => {
                    if (currentBlobData && blobIndex <= this.options.maxBlobs) {
                        currentBlobData.ways.count++;
                        this.stats.referenceParser.totalWays++;
                        
                        if (currentBlobData.ways.samples.length < this.options.maxSampleWays) {
                            currentBlobData.ways.samples.push({
                                id: way.id,
                                nodeRefs: way.nodeRefs || [],
                                tags: way.tags || {}
                            });
                        }
                    }
                },
                relation: (relation) => {
                    if (currentBlobData && blobIndex <= this.options.maxBlobs) {
                        currentBlobData.relations.count++;
                        this.stats.referenceParser.totalRelations++;
                        
                        if (currentBlobData.relations.samples.length < this.options.maxSampleRelations) {
                            currentBlobData.relations.samples.push({
                                id: relation.id,
                                members: relation.members || [],
                                tags: relation.tags || {}
                            });
                        }
                    }
                }
            };
            
            // Start parsing
            try {
                pbfParser.parse(parseOptions);
            } catch (error) {
                reject(error);
            }
        });
    }

    analyzeCustomBlob(osmBlob, blobIndex) {
        const analysis = {
            blobIndex: blobIndex,
            stringtable: {
                size: 0,
                samples: []
            },
            nodes: {
                count: 0,
                samples: []
            },
            ways: {
                count: 0,
                samples: []
            },
            relations: {
                count: 0,
                samples: []
            },
            summary: '',
            errors: []
        };
        
        try {
            // Analyze stringtable
            let stringCount = 0;
            for (const [index, value] of osmBlob.iterate_stringtable()) {
                stringCount++;
                if (analysis.stringtable.samples.length < 10) {
                    analysis.stringtable.samples.push({ index, value });
                }
            }
            analysis.stringtable.size = stringCount;
            
            // Analyze nodes
            let nodeCount = 0;
            for (const node of osmBlob.iterateNodes()) {
                nodeCount++;
                if (analysis.nodes.samples.length < this.options.maxSampleNodes) {
                    analysis.nodes.samples.push({
                        id: node.id,
                        lat: node.lat,
                        lon: node.lon,
                        tags: node.tags || {}
                    });
                }
            }
            analysis.nodes.count = nodeCount;
            this.stats.customParser.totalNodes += nodeCount;
            
            // Analyze ways
            let wayCount = 0;
            for (const way of osmBlob.iterateWays()) {
                wayCount++;
                if (analysis.ways.samples.length < this.options.maxSampleWays) {
                    analysis.ways.samples.push({
                        id: way.id,
                        nodeRefs: way.refs || [],
                        tags: way.tags || {}
                    });
                }
            }
            analysis.ways.count = wayCount;
            this.stats.customParser.totalWays += wayCount;
            
            // Analyze relations
            let relationCount = 0;
            for (const relation of osmBlob.iterateRelations()) {
                relationCount++;
                if (analysis.relations.samples.length < this.options.maxSampleRelations) {
                    analysis.relations.samples.push({
                        id: relation.id,
                        members: relation.members || [],
                        tags: relation.tags || {}
                    });
                }
            }
            analysis.relations.count = relationCount;
            this.stats.customParser.totalRelations += relationCount;
            
            analysis.summary = `${nodeCount} nodes, ${wayCount} ways, ${relationCount} relations, ${stringCount} strings`;
            
        } catch (error) {
            analysis.errors.push(error.message);
            this.stats.customParser.errors++;
        }
        
        return analysis;
    }

    addReferenceNode(node, blobIndex) {
        // Ensure we have a blob data entry for this index
        if (!this.referenceBlobData[blobIndex]) {
            this.referenceBlobData[blobIndex] = {
                blobIndex: blobIndex,
                nodes: { count: 0, samples: [] },
                ways: { count: 0, samples: [] },
                relations: { count: 0, samples: [] }
            };
        }
        
        const blobData = this.referenceBlobData[blobIndex];
        blobData.nodes.count++;
        this.stats.referenceParser.totalNodes++;
        
        if (blobData.nodes.samples.length < this.options.maxSampleNodes) {
            blobData.nodes.samples.push({
                id: node.id,
                lat: node.lat,
                lon: node.lon,
                tags: node.tags || {}
            });
        }
    }

    addReferenceWay(way, blobIndex) {
        if (!this.referenceBlobData[blobIndex]) {
            this.referenceBlobData[blobIndex] = {
                blobIndex: blobIndex,
                nodes: { count: 0, samples: [] },
                ways: { count: 0, samples: [] },
                relations: { count: 0, samples: [] }
            };
        }
        
        const blobData = this.referenceBlobData[blobIndex];
        blobData.ways.count++;
        this.stats.referenceParser.totalWays++;
        
        if (blobData.ways.samples.length < this.options.maxSampleWays) {
            blobData.ways.samples.push({
                id: way.id,
                nodeRefs: way.nodeRefs || [],
                tags: way.tags || {}
            });
        }
    }

    addReferenceRelation(relation, blobIndex) {
        if (!this.referenceBlobData[blobIndex]) {
            this.referenceBlobData[blobIndex] = {
                blobIndex: blobIndex,
                nodes: { count: 0, samples: [] },
                ways: { count: 0, samples: [] },
                relations: { count: 0, samples: [] }
            };
        }
        
        const blobData = this.referenceBlobData[blobIndex];
        blobData.relations.count++;
        this.stats.referenceParser.totalRelations++;
        
        if (blobData.relations.samples.length < this.options.maxSampleRelations) {
            blobData.relations.samples.push({
                id: relation.id,
                members: relation.members || [],
                tags: relation.tags || {}
            });
        }
    }

    compareResults() {
        console.log('\n📋 Blob-by-Blob Comparison');
        console.log('==========================');
        
        const maxBlobs = Math.max(this.customBlobData.length, this.referenceBlobData.length);
        
        for (let i = 0; i < maxBlobs; i++) {
            const customBlob = this.customBlobData[i];
            const referenceBlob = this.referenceBlobData[i];
            
            console.log(`\n🔸 Blob ${i}:`);
            
            if (!customBlob && !referenceBlob) {
                console.log('  ⚠️  No data from either parser');
                continue;
            }
            
            if (!customBlob) {
                console.log('  ❌ Missing from custom parser');
                this.stats.discrepancies.push(`Blob ${i}: Missing from custom parser`);
                continue;
            }
            
            if (!referenceBlob) {
                console.log('  ❌ Missing from reference parser');
                this.stats.discrepancies.push(`Blob ${i}: Missing from reference parser`);
                continue;
            }
            
            // Compare counts
            this.compareBlobCounts(customBlob, referenceBlob, i);
            
            // Compare sample data
            if (this.options.verbose) {
                this.compareBlobSamples(customBlob, referenceBlob, i);
            }
        }
    }

    compareBlobCounts(customBlob, referenceBlob, blobIndex) {
        const customNodeCount = customBlob.nodes?.count || 0;
        const refNodeCount = referenceBlob.nodes?.count || 0;
        const customWayCount = customBlob.ways?.count || 0;
        const refWayCount = referenceBlob.ways?.count || 0;
        const customRelCount = customBlob.relations?.count || 0;
        const refRelCount = referenceBlob.relations?.count || 0;
        
        console.log(`  📊 Nodes: Custom=${customNodeCount}, Reference=${refNodeCount} ${this.getMatchIcon(customNodeCount, refNodeCount)}`);
        console.log(`  📊 Ways: Custom=${customWayCount}, Reference=${refWayCount} ${this.getMatchIcon(customWayCount, refWayCount)}`);
        console.log(`  📊 Relations: Custom=${customRelCount}, Reference=${refRelCount} ${this.getMatchIcon(customRelCount, refRelCount)}`);
        
        if (customNodeCount !== refNodeCount) {
            this.stats.discrepancies.push(`Blob ${blobIndex}: Node count mismatch (${customNodeCount} vs ${refNodeCount})`);
        }
        if (customWayCount !== refWayCount) {
            this.stats.discrepancies.push(`Blob ${blobIndex}: Way count mismatch (${customWayCount} vs ${refWayCount})`);
        }
        if (customRelCount !== refRelCount) {
            this.stats.discrepancies.push(`Blob ${blobIndex}: Relation count mismatch (${customRelCount} vs ${refRelCount})`);
        }
    }

    compareBlobSamples(customBlob, referenceBlob, blobIndex) {
        console.log(`    🔍 Sample Nodes:`);
        const customNodes = customBlob.nodes?.samples || [];
        const refNodes = referenceBlob.nodes?.samples || [];
        
        for (let i = 0; i < Math.max(customNodes.length, refNodes.length); i++) {
            const custom = customNodes[i];
            const ref = refNodes[i];
            
            if (custom && ref) {
                const match = this.compareNodeSample(custom, ref);
                console.log(`      Node ${i}: ${match ? '✅' : '❌'} ID=${custom.id}`);
                if (!match && this.options.verbose) {
                    console.log(`        Custom: lat=${custom.lat}, lon=${custom.lon}, tags=${JSON.stringify(custom.tags)}`);
                    console.log(`        Reference: lat=${ref.lat}, lon=${ref.lon}, tags=${JSON.stringify(ref.tags)}`);
                }
            } else if (custom) {
                console.log(`      Node ${i}: ❌ Only in custom: ID=${custom.id}`);
            } else if (ref) {
                console.log(`      Node ${i}: ❌ Only in reference: ID=${ref.id}`);
            }
        }
    }

    compareNodeSample(custom, ref) {
        return custom.id === ref.id &&
               Math.abs(custom.lat - ref.lat) < 1e-10 &&
               Math.abs(custom.lon - ref.lon) < 1e-10 &&
               JSON.stringify(custom.tags) === JSON.stringify(ref.tags);
    }

    getMatchIcon(a, b) {
        return a === b ? '✅' : '❌';
    }

    printFinalReport() {
        console.log('===============================');
        console.log('\n📈 Parser Statistics:');
        console.log('  Custom Parser:');
        console.log(`    Blobs: ${this.stats.customParser.blobsProcessed}`);
        console.log(`    Nodes: ${this.stats.customParser.totalNodes}`);
        console.log(`    Ways: ${this.stats.customParser.totalWays}`);
        console.log(`    Relations: ${this.stats.customParser.totalRelations}`);
        console.log(`    Errors: ${this.stats.customParser.errors}`);
        
        console.log('\n  Reference Parser:');
        console.log(`    Blobs: ${this.stats.referenceParser.blobsProcessed}`);
        console.log(`    Nodes: ${this.stats.referenceParser.totalNodes}`);
        console.log(`    Ways: ${this.stats.referenceParser.totalWays}`);
        console.log(`    Relations: ${this.stats.referenceParser.totalRelations}`);
        console.log(`    Errors: ${this.stats.referenceParser.errors}`);
        
        console.log('\n🔍 Discrepancies:');
        if (this.stats.discrepancies.length === 0) {
            console.log('  ✅ No discrepancies found - parsers match perfectly!');
        } else {
            this.stats.discrepancies.forEach((discrepancy, index) => {
                console.log(`  ${index + 1}. ${discrepancy}`);
            });
        }
        
        console.log('\n🎯 Overall Result:');
        const totalErrors = this.stats.customParser.errors + this.stats.referenceParser.errors;
        const totalDiscrepancies = this.stats.discrepancies.length;
        
        if (totalErrors === 0 && totalDiscrepancies === 0) {
            console.log('  🎉 SUCCESS: Both parsers agree completely!');
        } else if (totalDiscrepancies === 0) {
            console.log('  ⚠️  PARTIAL SUCCESS: Parsers agree but had some errors');
        } else {
            console.log('  ❌ ISSUES FOUND: Discrepancies detected between parsers');
        }
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const filePath = args[0] || './test/input/pitcairn-islands-latest.osm.pbf';
    
    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
    }
    
    const options = {
        maxBlobs: 5,
        verbose: true,
        showRawStructure: false,
        maxSampleNodes: 3,
        maxSampleWays: 2,
        maxSampleRelations: 1
    };
    
    const comparator = new ParserComparator(options);
    await comparator.compare(filePath);
}

if (require.main === module) {
    main().catch(error => {
        console.error('❌ Fatal error:', error.message);
        if (process.env.DEBUG) {
            console.error(error.stack);
        }
        process.exit(1);
    });
}

module.exports = { ParserComparator };
