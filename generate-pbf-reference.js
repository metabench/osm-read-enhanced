#!/usr/bin/env node

/*
 * PBF Reference Data Generator
 * ===========================
 * 
 * This script uses the existing pbfParser (with protobuf library) as the "ground truth"
 * to generate comprehensive reference data about what's actually in a PBF file.
 * This helps us understand the expected structure and debug our custom parsing.
 */

const osmread = require('./lib/main.js');
const OSM_Blob = require('./lib/OSM_Blob.js');

function generateReferenceData(filePath) {
    console.log('🔍 PBF REFERENCE DATA GENERATOR');
    console.log('═'.repeat(80));
    console.log(`📁 File: ${filePath}`);
    
    return new Promise((resolve, reject) => {
        osmread.createPbfParser({
            filePath: filePath,
            callback: function(err, parser) {
                if (err) {
                    return reject(err);
                }
                
                console.log(`📦 Total file blocks found: ${parser.fileBlocks.length}`);
                
                // Analyze each type of block
                const headerBlocks = parser.findFileBlocksByBlobType('OSMHeader');
                const dataBlocks = parser.findFileBlocksByBlobType('OSMData');
                
                console.log(`📋 Block types:`);
                console.log(`   🏷️  OSMHeader blocks: ${headerBlocks.length}`);
                console.log(`   📊 OSMData blocks: ${dataBlocks.length}`);
                console.log('');
                
                // Process header blocks first
                processHeaderBlocks(parser, headerBlocks)
                    .then(() => processDataBlocks(parser, dataBlocks))
                    .then(() => {
                        parser.close();
                        resolve();
                    })
                    .catch(reject);
            }
        });
    });
}

async function processHeaderBlocks(parser, headerBlocks) {
    console.log('🏷️  PROCESSING OSMHEADER BLOCKS');
    console.log('─'.repeat(50));
    
    for (let i = 0; i < headerBlocks.length; i++) {
        const block = headerBlocks[i];
        console.log(`\n📦 Header Block ${i} (position: ${block.position})`);
        
        try {
            const parsedBlock = await new Promise((resolve, reject) => {
                parser.readBlock(block, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
            
            console.log(`   🔤 Block properties:`);
            Object.keys(parsedBlock).forEach(key => {
                const value = parsedBlock[key];
                let displayValue;
                
                if (Buffer.isBuffer(value)) {
                    displayValue = `Buffer(${value.length} bytes)`;
                } else if (Array.isArray(value)) {
                    displayValue = `Array[${value.length}]`;
                } else if (typeof value === 'object' && value !== null) {
                    displayValue = `Object{${Object.keys(value).join(', ')}}`;
                } else {
                    displayValue = JSON.stringify(value);
                }
                
                console.log(`     ${key}: ${displayValue}`);
            });
            
            // Special handling for known header fields
            if (parsedBlock.bbox) {
                console.log(`   🌍 Bounding Box:`);
                console.log(`     Left: ${parsedBlock.bbox.left}`);
                console.log(`     Right: ${parsedBlock.bbox.right}`);
                console.log(`     Top: ${parsedBlock.bbox.top}`);
                console.log(`     Bottom: ${parsedBlock.bbox.bottom}`);
            }
            
            if (parsedBlock.required_features) {
                console.log(`   🔧 Required Features: ${JSON.stringify(parsedBlock.required_features)}`);
            }
            
            if (parsedBlock.optional_features) {
                console.log(`   ⚙️  Optional Features: ${JSON.stringify(parsedBlock.optional_features)}`);
            }
            
        } catch (error) {
            console.log(`   ❌ Error parsing header block: ${error.message}`);
        }
    }
}

async function processDataBlocks(parser, dataBlocks) {
    console.log('\n\n📊 PROCESSING OSMDATA BLOCKS');
    console.log('─'.repeat(50));
    
    // Limit to first few blocks for detailed analysis
    const blocksToAnalyze = Math.min(3, dataBlocks.length);
    console.log(`📋 Analyzing first ${blocksToAnalyze} of ${dataBlocks.length} data blocks...\n`);
    
    for (let i = 0; i < blocksToAnalyze; i++) {
        const block = dataBlocks[i];
        console.log(`📦 Data Block ${i} (position: ${block.position}, size: ${block.size} bytes)`);
        
        try {
            const parsedBlock = await new Promise((resolve, reject) => {
                parser.readBlock(block, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
            
            await analyzeDataBlock(parsedBlock, i);
            
        } catch (error) {
            console.log(`   ❌ Error parsing data block ${i}: ${error.message}`);
        }
    }
}

async function analyzeDataBlock(parsedBlock, blockIndex) {
    console.log(`\n🔍 DETAILED ANALYSIS OF DATA BLOCK ${blockIndex}:`);
    
    // Block-level properties
    console.log(`   📐 Block Properties:`);
    console.log(`     granularity: ${parsedBlock.granularity || 'default (100)'}`);
    console.log(`     lat_offset: ${parsedBlock.latOffset || 0}`);
    console.log(`     lon_offset: ${parsedBlock.lonOffset || 0}`);
    console.log(`     date_granularity: ${parsedBlock.dateGranularity || 'default (1000)'}`);
    
    // String table analysis
    if (parsedBlock.stringtable) {
        console.log(`   🔤 StringTable Analysis:`);
        console.log(`     Total strings: ${parsedBlock.stringtable.s ? parsedBlock.stringtable.s.length : 0}`);
        
        if (parsedBlock.stringtable.s && parsedBlock.stringtable.s.length > 0) {
            console.log(`     Sample strings:`);
            for (let i = 0; i < Math.min(15, parsedBlock.stringtable.s.length); i++) {
                try {
                    const str = parsedBlock.stringtable.getEntry(i);
                    const display = str.length > 50 ? str.substring(0, 50) + '...' : str;
                    console.log(`       [${i}] "${display}"`);
                } catch (e) {
                    console.log(`       [${i}] <error: ${e.message}>`);
                }
            }
        }
    }
    
    // Primitive groups analysis
    if (parsedBlock.primitivegroup) {
        console.log(`   📊 PrimitiveGroups: ${parsedBlock.primitivegroup.length} groups`);
        
        let totalNodes = 0, totalWays = 0, totalRelations = 0;
        
        parsedBlock.primitivegroup.forEach((pg, pgIndex) => {
            console.log(`     Group ${pgIndex}:`);
            
            // Analyze nodes
            if (pg.nodesView && pg.nodesView.length > 0) {
                totalNodes += pg.nodesView.length;
                console.log(`       📍 Nodes: ${pg.nodesView.length}`);
                
                // Sample node
                if (pg.nodesView.length > 0) {
                    try {
                        const sampleNode = pg.nodesView.get(0);
                        console.log(`         Sample: ID=${sampleNode.id}, lat=${sampleNode.lat.toFixed(6)}, lon=${sampleNode.lon.toFixed(6)}`);
                        
                        const tagKeys = Object.keys(sampleNode.tags || {});
                        if (tagKeys.length > 0) {
                            console.log(`         Tags: ${tagKeys.slice(0, 3).join(', ')}${tagKeys.length > 3 ? '...' : ''}`);
                        }
                    } catch (e) {
                        console.log(`         Sample node error: ${e.message}`);
                    }
                }
            }
            
            // Analyze ways
            if (pg.waysView && pg.waysView.length > 0) {
                totalWays += pg.waysView.length;
                console.log(`       🛣️  Ways: ${pg.waysView.length}`);
                
                // Sample way
                if (pg.waysView.length > 0) {
                    try {
                        const sampleWay = pg.waysView.get(0);
                        console.log(`         Sample: ID=${sampleWay.id}, refs=${sampleWay.nodeRefs ? sampleWay.nodeRefs.length : 0} nodes`);
                        
                        const tagKeys = Object.keys(sampleWay.tags || {});
                        if (tagKeys.length > 0) {
                            console.log(`         Tags: ${tagKeys.slice(0, 3).join(', ')}${tagKeys.length > 3 ? '...' : ''}`);
                        }
                    } catch (e) {
                        console.log(`         Sample way error: ${e.message}`);
                    }
                }
            }
            
            // Analyze relations
            if (pg.relationsView && pg.relationsView.length > 0) {
                totalRelations += pg.relationsView.length;
                console.log(`       🔗 Relations: ${pg.relationsView.length}`);
                
                // Sample relation
                if (pg.relationsView.length > 0) {
                    try {
                        const sampleRelation = pg.relationsView.get(0);
                        console.log(`         Sample: ID=${sampleRelation.id}, members=${sampleRelation.members ? sampleRelation.members.length : 0}`);
                        
                        const tagKeys = Object.keys(sampleRelation.tags || {});
                        if (tagKeys.length > 0) {
                            console.log(`         Tags: ${tagKeys.slice(0, 3).join(', ')}${tagKeys.length > 3 ? '...' : ''}`);
                        }
                    } catch (e) {
                        console.log(`         Sample relation error: ${e.message}`);
                    }
                }
            }
            
            // Check for dense nodes (most common)
            if (pg.dense) {
                console.log(`       📍 Dense Nodes: ${pg.dense.id ? pg.dense.id.length : 0} nodes`);
                if (pg.dense.keysVals) {
                    console.log(`         Keys/Values array: ${pg.dense.keysVals.length} entries`);
                }
            }
        });
        
        console.log(`   📈 Block Totals: ${totalNodes} nodes, ${totalWays} ways, ${totalRelations} relations`);
    }
    
    console.log('   ─'.repeat(40));
}

// Enhanced comparison with our custom parser
async function compareWithCustomParser(filePath) {
    console.log('\n\n🔬 COMPARING WITH CUSTOM PARSER');
    console.log('─'.repeat(50));
    
    // This would create an OSM_Blob and compare results
    // For now, we'll focus on the reference data generation above
}

// Main execution
if (require.main === module) {
    const filePath = process.argv[2] || "test/input/pitcairn-islands-latest.osm.pbf";
    
    console.log('Starting PBF Reference Data Generation...\n');
    
    generateReferenceData(filePath)
        .then(() => {
            console.log('\n' + '═'.repeat(80));
            console.log('🎉 Reference data generation complete!');
            console.log('This output shows the expected structure using the proven pbfParser.');
            console.log('Use this as reference when debugging custom parsing issues.');
        })
        .catch((error) => {
            console.error('\n❌ Error generating reference data:');
            console.error(error.message);
            console.error(error.stack);
            process.exit(1);
        });
}
