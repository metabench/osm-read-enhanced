const assert = require('assert');
const { test } = require('node:test');
const osmread = require('../lib/main');

/**
 * Test Suite: Comprehensive PBF Parsing
 * Description: Tests the functionality of parsing the Pitcairn Islands PBF file.
 */

test('Comprehensive PBF Parsing: Validate OSMHeader block', async (t) => {
    let parser;

    await new Promise((resolve, reject) => {
        osmread.createPbfParser({
            filePath: 'test/input/pitcairn-islands-latest.osm.pbf',
            callback: function (err, p) {
                if (err) {
                    reject(err);
                } else {
                    parser = p;
                    resolve();
                }
            },
        });
    });

    t.after(() => {
        return new Promise((resolve, reject) => {
            parser.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    // Clean up worker pool after parser closes
                    try {
                        const zlib = require('../lib/nodejs/zlib');
                        zlib.shutdownWorkerPool();
                    } catch (e) {
                        // Ignore if already shut down
                    }
                    resolve();
                }
            });
        });
    });

    await t.test('OSMHeader contains required features', async () => {
        const blocks = parser.findFileBlocksByBlobType('OSMHeader');
        assert.strictEqual(blocks.length, 1);

        await new Promise((resolve, reject) => {
            parser.readBlock(blocks[0], (err, block) => {
                if (err) {
                    reject(err);
                } else {
                    const requiredFeatures = block.requiredFeatures || [];
                    assert.ok(requiredFeatures.includes('OsmSchema-V0.6'));
                    assert.ok(requiredFeatures.includes('DenseNodes'));
                    resolve();
                }
            });
        });
    });
});

test('Comprehensive PBF Parsing: Validate Nodes', async (t) => {
    let parser;

    await new Promise((resolve, reject) => {
        osmread.createPbfParser({
            filePath: 'test/input/pitcairn-islands-latest.osm.pbf',
            callback: function (err, p) {
                if (err) {
                    reject(err);
                } else {
                    parser = p;
                    resolve();
                }
            },
        });
    });

    t.after(() => {
        return new Promise((resolve, reject) => {
            parser.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    // Clean up worker pool after parser closes
                    try {
                        const zlib = require('../lib/nodejs/zlib');
                        zlib.shutdownWorkerPool();
                    } catch (e) {
                        // Ignore if already shut down
                    }
                    resolve();
                }
            });
        });
    });

    await t.test('Nodes are parsed correctly', async () => {
        const blocks = parser.findFileBlocksByBlobType('OSMData');
        assert.ok(blocks.length > 0);

        await new Promise((resolve, reject) => {
            parser.readBlock(blocks[0], (err, block) => {
                if (err) {
                    reject(err);
                } else {
                    const nodes = block.primitivegroup[0].nodesView;
                    assert.ok(nodes.length > 0);

                    const firstNode = nodes.get(0);
                    assert.ok(firstNode.id);
                    assert.ok(firstNode.lat);
                    assert.ok(firstNode.lon);
                    resolve();
                }
            });
        });
    });
});

test('Comprehensive PBF Parsing: Validate Ways', async (t) => {
    let parser;

    await new Promise((resolve, reject) => {
        osmread.createPbfParser({
            filePath: 'test/input/pitcairn-islands-latest.osm.pbf',
            callback: function (err, p) {
                if (err) {
                    reject(err);
                } else {
                    parser = p;
                    resolve();
                }
            },
        });
    });

    t.after(() => {
        return new Promise((resolve, reject) => {
            parser.close((err) => {
                if (err) {
                    reject(err);
                } else {
                    // Clean up worker pool after parser closes
                    try {
                        const zlib = require('../lib/nodejs/zlib');
                        zlib.shutdownWorkerPool();
                    } catch (e) {
                        // Ignore if already shut down
                    }
                    resolve();
                }
            });
        });
    });

    await t.test('Ways are parsed correctly', async () => {
        const blocks = parser.findFileBlocksByBlobType('OSMData');
        assert.ok(blocks.length > 2); // Ensure we have at least 3 blocks

        await new Promise((resolve, reject) => {
            parser.readBlock(blocks[2], (err, block) => { // Use block 2 which contains ways
                if (err) {
                    reject(err);
                } else {
                    const ways = block.primitivegroup[0].waysView;
                    assert.ok(ways.length > 0);

                    const firstWay = ways.get(0);
                    assert.ok(firstWay.id);
                    assert.ok(firstWay.nodeRefs.length > 0);
                    resolve();
                }
            });
        });
    });
});

// Ensure worker threads are properly cleaned up when tests complete
process.on('exit', () => {
    try {
        const zlib = require('../lib/nodejs/zlib');
        zlib.shutdownWorkerPool();
    } catch (e) {
        // Ignore if already shut down
    }
});

// Also handle SIGINT and SIGTERM
process.on('SIGINT', () => {
    try {
        const zlib = require('../lib/nodejs/zlib');
        zlib.shutdownWorkerPool();
    } catch (e) {
        // Ignore if already shut down
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    try {
        const zlib = require('../lib/nodejs/zlib');
        zlib.shutdownWorkerPool();
    } catch (e) {
        // Ignore if already shut down
    }
    process.exit(0);
});