/*
 * The following little overview extends the osm pbf file structure description
 * from http://wiki.openstreetmap.org/wiki/PBF_Format:
 *
 * - [1] file
 *   - [n] file blocks
 *     - [1] blob header
 *     - [1] blob
 */

var protobuf = require('protobufjs/minimal');
var proto = require('./proto/index.js');
var buf = require('./buffer.js');

var zlib, reader, arrayBufferReader, fileReader;

// check if running in Browser or Node.js (use self not window because of Web Workers)
if (typeof self !== 'undefined') {
    zlib = require('./browser/zlib.js');
    arrayBufferReader = require('./browser/arrayBufferReader.js');
    fileReader = require('./browser/fileReader.js');
} else {
    zlib = require('./nodejs/zlib.js');
    reader = require('./nodejs/fsReader.js');
}

function parse(opts){
    var paused, resumeCallback, documentEndReached;

    documentEndReached = false;
    paused = false;
    resumeCallback = null;

    createPathParser({
        filePath: opts.filePath,
        buffer: opts.buffer,
        file: opts.file,
        callback: function(err, parser){
            var nextFileBlockIndex;

            function fail(err){
                if( parser ){
                    parser.close();
                }

                return opts.error(err);
            }

            if(err){
                return fail(err);
            }

            nextFileBlockIndex = 0;

            function visitNextBlock(){
                var fileBlock;

                if(documentEndReached || paused){
                    return;
                }

                if(nextFileBlockIndex >= parser.fileBlocks.length){
                    documentEndReached = true;

                    parser.close();

                    opts.endDocument();

                    return;
                }

                fileBlock = parser.fileBlocks[nextFileBlockIndex];

                parser.readBlock(fileBlock, function(err, block){
                    if(err){
                        return fail(err);
                    }

                    visitBlock(fileBlock, block, opts);

                    nextFileBlockIndex += 1;

                    visitNextBlock();
                });
            }

            resumeCallback = visitNextBlock;

            visitNextBlock();
        }
    });

    function pause(){
        paused = true;
    }

    function resume(){
        paused = false;

        if(resumeCallback){
            resumeCallback();
        }
    }

    return {
        pause: pause,

        resume: resume
    };
}

function createPathParser(opts){
    reader = getReader(opts);
    reader.open(opts, function(err, fd){
        createFileParser(fd, function(err, parser){
            if(err){
                return opts.callback(err);
            }

            parser.close = function(callback){
                return reader.close(fd, callback);
            };

            return opts.callback(null, parser);
        });
    });
}

function getReader(opts){
    if(!arrayBufferReader){
        // Node.js
        return reader;
    }

    if(opts.file){
        return fileReader;
    }
    return arrayBufferReader;
}

function visitBlock(fileBlock, block, opts){
    BLOCK_VISITORS_BY_TYPE[fileBlock.blobHeader.type](block, opts);
}

function visitOSMHeaderBlock(block, opts){
    // TODO
}

function visitOSMDataBlock(block, opts){
    var i;

    for(i = 0; i < block.primitivegroup.length; ++i){
        visitPrimitiveGroup(block.primitivegroup[i], opts);
    }
}

function visitPrimitiveGroup(pg, opts){
    var i;

    // visit nodes
    if(opts.node){
        for(i = 0; i < pg.nodesView.length; ++i){
            opts.node(pg.nodesView.get(i));
        }
    }

    // visit ways
    if(opts.way){
        for(i = 0; i < pg.waysView.length; ++i){
            opts.way(pg.waysView.get(i));
        }
    }

    // visit relations
    if(opts.relation){
        for(i = 0; i < pg.relationsView.length; ++i){
            opts.relation(pg.relationsView.get(i));
        }
    }
}

var BLOCK_VISITORS_BY_TYPE = {
    OSMHeader: visitOSMHeaderBlock,
    OSMData: visitOSMDataBlock
};

var BLOB_HEADER_SIZE_SIZE = 4;

function readBlobHeaderContent(fd, position, size, callback){
    return reader.readPBFElement(fd, position, size, proto.OSMPBF.BlobHeader.decode, callback);
}

function readFileBlock(fd, position, callback){
    reader.readBlobHeaderSize(fd, position, BLOB_HEADER_SIZE_SIZE, function(err, blobHeaderSize){
        if(err){
            return callback(err);
        }

        return readBlobHeaderContent(fd, position + BLOB_HEADER_SIZE_SIZE, blobHeaderSize, function(err, blobHeader){
            if(err){
                return callback(err);
            }

            blobHeader.position = position + BLOB_HEADER_SIZE_SIZE + blobHeaderSize;

            return callback(err, {
                position: position,
                size: BLOB_HEADER_SIZE_SIZE + blobHeaderSize + blobHeader.datasize,
                blobHeader: blobHeader
            });
        });
    });
}

function readFileBlocks(fd, callback){
    reader.getFileSize(fd, function(err, fileSize){
        var position, fileBlocks;

        position = 0;
        fileBlocks = [];

        function readNextFileBlock(){
            readFileBlock(fd, position, function(err, fileBlock){
                if(err){
                    return callback(err);
                }

                fileBlocks.push(fileBlock);

                position = fileBlock.position + fileBlock.size;

                if(position < fileSize){
                    readNextFileBlock();
                }
                else{
                    return callback(null, fileBlocks);
                }
            });
        }

        readNextFileBlock();
    });
}

function getStringTableEntry(i){
    var s, str;

    // decode StringTable entry only once and cache
    if (i in this.cache) {
        str = this.cache[i];
    } else {
        s = this.s[i];

        str = protobuf.util.utf8.read(s, 0, s.length);
        this.cache[i] = str;
    }

    return str;
}

function extendStringTable(st){
    st.cache = {};
    st.getEntry = getStringTableEntry;
}

function createNodesView(pb, pg){
    let length = 0, tagsList, deltaData;

    if(pg.nodes.length !== 0){
        throw new Error('primitivegroup.nodes.length !== 0 not supported yet');
    }

    //length = 0;

    if(pg.dense){
        length = pg.dense.id.length;
    }

    function createTagsList(){
        var tagsList, i, tagsListI, tags, keyId, keysVals, valId, key, val;

        if(!pg.dense){
            return null;
        }

        keysVals = pg.dense.keysVals;
        tags = {};
        tagsList = [];
        const l = keysVals.length;

        for(i = 0; i < l;){
            keyId = keysVals[i++];
            if(keyId === 0){
                tagsList.push(tags);
                tags = {};
                continue;
            }

            valId = keysVals[i++];
            key = pb.stringtable.getEntry(keyId);
            val = pb.stringtable.getEntry(valId);
            tags[key] = val;
        }

        return tagsList;
    }

    tagsList = createTagsList();

    function collectDeltaData(){
        let i, id, timestamp, changeset, uid, userIndex, deltaDataList, deltaData, lat, lon;

        if(!pg.dense){
            return null;
        }

        id = 0;
        lat = 0;
        lon = 0;

        if(pg.dense.denseinfo){
            timestamp = 0;
            changeset = 0;
            uid = 0;
            userIndex = 0;
        }

        deltaDataList = [];

        for(i = 0; i < length; ++i){
            // TODO we should test wheather adding 64bit numbers works fine with high values
            id += toNumber(pg.dense.id[i]);

            lat += toNumber(pg.dense.lat[i]);
            lon += toNumber(pg.dense.lon[i]);

            deltaData = {
                id: id,
                lat: lat,
                lon: lon
            };

            if(pg.dense.denseinfo){
                // TODO we should test wheather adding 64bit numbers works fine with high values
                timestamp += toNumber(pg.dense.denseinfo.timestamp[i]);
                changeset += toNumber(pg.dense.denseinfo.changeset[i]);

                // TODO we should test wheather adding 64bit numbers works fine with high values
                uid += pg.dense.denseinfo.uid[i];

                userIndex += pg.dense.denseinfo.userSid[i];

                deltaData.timestamp = timestamp * pb.dateGranularity;
                deltaData.changeset = changeset;
                deltaData.uid = uid;
                deltaData.userIndex = userIndex;
            }

            deltaDataList.push(deltaData);
        }

        return deltaDataList;
    }

    

    // get all node ids in a block, in a typed array
    //  This could be used by / with the block cache.
    //   Caching the (indexes) of nodes within blocks could help.


    // get_ids function
    function get_ids() {
        const res = new BigUint64Array(length);
        let id = BigInt(0);

        for(i = 0; i < length; ++i){
            // TODO we should test wheather adding 64bit numbers works fine with high values
            id += BigInt(toNumber(pg.dense.id[i]));
            res[i] = (id);

        }
        return res;
    }

    function get_coords() {
        const res = new Float32Array(length * 2);

        //let id = BigInt(0);
        let lat = 0, lon = 0;
        //let w = 0;

        for(let i = 0, w = 0; i < length; ++i){
            // TODO we should test wheather adding 64bit numbers works fine with high values
            //id += BigInt(toNumber(pg.ways[i].id));
            lat += toNumber(pg.dense.lat[i]);
            lon += toNumber(pg.dense.lon[i]);
            res[w++] = (toNumber(pb.latOffset) + (pb.granularity * lat)) / 1000000000;
            res[w++] = (toNumber(pb.lonOffset) + (pb.granularity * lon)) / 1000000000;
            //res[i] = BigInt(toNumber(pg.ways[i].id));

        }
        return res;
    }

    // A different path that does not build the deltaData array would be nice.
    //  It would build some different typed array(s).
    //   An IDs typed array
    //   a points typed array.


    function get(i){
        if (deltaData === undefined) deltaData = collectDeltaData();
        const nodeDeltaData = deltaData[i], node = {
            id: BigInt(nodeDeltaData.id),
            lat: (toNumber(pb.latOffset) + (pb.granularity * nodeDeltaData.lat)) / 1000000000,
            lon: (toNumber(pb.lonOffset) + (pb.granularity * nodeDeltaData.lon)) / 1000000000,
            tags: tagsList[i]
        };

        if(pg.dense.denseinfo){
            node.version = pg.dense.denseinfo.version[i];
            node.timestamp = nodeDeltaData.timestamp;
            node.changeset = nodeDeltaData.changeset;
            node.uid = '' + nodeDeltaData.uid;
            node.user = pb.stringtable.getEntry(nodeDeltaData.userIndex);
        }

        return node;
    }

    return {
        length,
        get,
        get_ids,
        get_coords
    };
}

function createTagsObject(pb, entity){
    let tags = {}, i, len, keyI, valI, key, val;

    //tags = {};

    for(i = 0, len = entity.keys.length; i < len; ++i){
        keyI = entity.keys[i];
        valI = entity.vals[i];

        key = pb.stringtable.getEntry(keyI);
        val = pb.stringtable.getEntry(valI);

        tags[key] = val;
    }

    return tags;
}

function addInfo(pb, result, info){
    if (info) {
        if (info.version) {
            result.version = info.version;
        }
        if (info.timestamp) {
            result.timestamp = toNumber(info.timestamp) * pb.dateGranularity;
        }
        if (info.changeset) {
            result.changeset = toNumber(info.changeset);
        }
        if (info.uid) {
            result.uid = '' + info.uid;
        }
        /*
        if (info.userSid) {
            result.user = pb.stringtable.getEntry(info.userSid);
        }
        */
    }
}

function createWaysView(pb, pg){
    const length = pg.ways.length;

    function get(i){
        var way, result, info;
        way = pg.ways[i];

        function createNodeRefIds(){
            let lastRefId = BigInt(0), i;
            //nodeIds = [];
            const ta_node_ids = new BigUint64Array(way.refs.length), l = way.refs.length;
            for(i = 0; i < l; ++i){
                // TODO we should test wheather adding 64bit numbers works fine with high values
                lastRefId += BigInt(toNumber(way.refs[i]));

                //nodeIds.push('' + lastRefId);
                ta_node_ids[i] = lastRefId;
            }
            return ta_node_ids;
        }
        
        // What about tags on demand?
        //  Whereby it does the stringtable lookup when asked.
        //   Could have tags iterator
        //   Could have a more concise tags raw data format.

        result = {
            id: BigInt(way.id),

            // Create tags on demand? A getter that creates the tags object could be more efficient.
            //  Could be more efficient still if it keeps that tags object in memory.
            //tags: createTagsObject(pb, way),
            //nodeRefs: createNodeRefIds()
        };

        let _tags;

        Object.defineProperty(result, 'tags', {
            get() {
                if (!_tags) _tags = createTagsObject(pb, way);
                return _tags;
            }
        });

        let _nodeRefs;

        Object.defineProperty(result, 'nodeRefs', {
            get() {
                if (!_nodeRefs) _nodeRefs = createNodeRefIds();
                return _nodeRefs;
            }
        });

        // And a property that's an iterator / generator of tags.

        function* create_tags_generator() {
            let i, len, keyI, valI, key, val;

            //tags = {};

            for(i = 0, len = way.keys.length; i < len; ++i){
                keyI = way.keys[i];
                valI = way.vals[i];

                key = pb.stringtable.getEntry(keyI);
                val = pb.stringtable.getEntry(valI);

                //tags[key] = val;
                yield [key, val];
            }

            //return tags;
        }

        Object.defineProperty(result, 'itags', {
            get() {
                return create_tags_generator();
            }
        });

        // and itags
        //  would helpfully iterate through the tags.
        //  [name, value] pairs of tags.


        // Could have info option / flag?

        addInfo(pb, result, way.info);

        return result;
    }

    function get_num_noderefs() {
        if (!this._num_noderefs) {
            const res = new Uint32Array(length);
            for (let i = 0; i < length; ++i){
                // TODO we should test wheather adding 64bit numbers works fine with high values
                //id += BigInt(toNumber(pg.ways[i].id));
                res[i] = BigInt(pg.ways[i].refs.length);
            }
            this._num_noderefs = res;
        }
        return this._num_noderefs;
    }

    function get_noderefs_start_idxs() {
        if (!this._noderefs_start_idxs) {
            const num_noderefs = this.get_num_noderefs();
            const res = new Uint32Array(length);
            res[0] = 0;
            for (let i = 1; i < length; ++i){
                // TODO we should test wheather adding 64bit numbers works fine with high values
                //id += BigInt(toNumber(pg.ways[i].id));
                res[i] = res[i - 1] + num_noderefs[i - 1];

            }
            this._noderefs_start_idxs = res;
        }
        return this._noderefs_start_idxs;
    }

    function get_ids() {
        const res = new BigUint64Array(length);
        //let id = BigInt(0);
        for(let i = 0; i < length; ++i){
            // TODO we should test wheather adding 64bit numbers works fine with high values
            //id += BigInt(toNumber(pg.ways[i].id));
            res[i] = BigInt(toNumber(pg.ways[i].id));

        }
        return res;
    }

    // get lengths of node refs (could use 16 bit?)
    //  32 bit seems simpler right now in terms of considerations.

    // Get the noderefs info all together.
    //  See about doing it in an optimised way.
    //   pg.ways[i].refs etc

    // function to count the total number of node refs.
    // Getting the tags in a more compact way?

    // May also want to iterate all strings in an osm pbf???
    //  Iterate all names?
    //  All names of X type places / items?

    // The number of tags in each?

    return {
        length,
        get,
        get_ids,
        get_num_noderefs,
        get_noderefs_start_idxs
    };
}

function createRelationsView(pb, pg){
    const length = pg.relations.length;

    function get(i){
        var relation, result, info;

        relation = pg.relations[i];

        function createMembers(){
            var members, memberObj, lastRefId, i, MemberType, type;

            MemberType = proto.OSMPBF.Relation.MemberType;
            members = [];
            lastRefId = 0;

            for(i = 0; i < relation.memids.length; ++i){
                memberObj = {};
                // TODO we should test wheather adding 64bit numbers works fine with high values
                lastRefId += toNumber(relation.memids[i]);
                memberObj.ref = BigInt(lastRefId);
                memberObj.role = pb.stringtable.getEntry(relation.rolesSid[i]);

                type = relation.types[i];
                if (MemberType.NODE === type) {
                    memberObj.type = 'node';
                } else if(MemberType.WAY === type) {
                    memberObj.type = 'way';
                } else if(MemberType.RELATION === type) {
                    memberObj.type = 'relation';
                }

                members.push(memberObj);
            }

            return members;
        }
        //console.log('relation', relation);
        //console.log('i', i);

        result = {
            id: relation.id.toString(),
            tags: createTagsObject(pb, relation),
            members: createMembers()
        };

        addInfo(pb, result, relation.info);

        return result;
    }

    // get_ids
    //  A different, faster lower level way of doing this through Block_Reader.
    //   Want to get the fastest return times for a variety of things.
    //   Avoiding even using the normal reader object construction will help.

    function get_ids() {
        const res = new BigUint64Array(length);
        //let id = BigInt(0);
        for(let i = 0; i < length; ++i){
            // TODO we should test wheather adding 64bit numbers works fine with high values
            //id += BigInt(toNumber(pg.ways[i].id));
            res[i] = BigInt(toNumber(pg.relations[i].id));
        }
        //console.log('get_ids res', res);
        return res;
    }

    return {
        length: length,
        get: get,
        get_ids
    };
}

function toNumber(x){
    return (typeof(x) === 'number' || typeof(x) === 'bigint') ? x : x.toNumber();
}

function extendPrimitiveGroup(pb, pg){
    pg.nodesView = createNodesView(pb, pg);
    pg.waysView = createWaysView(pb, pg);
    pg.relationsView = createRelationsView(pb, pg);
}

function decodePrimitiveBlock(buffer){
    let data = proto.OSMPBF.PrimitiveBlock.decode(buffer), i;
    const pgl = data.primitivegroup.length;
    // extend stringtable
    extendStringTable(data.stringtable);

    // extend primitivegroup
    
    for(i = 0; i < pgl; ++i){
        extendPrimitiveGroup(data, data.primitivegroup[i]);
    }

    return data;
}

var OSM_BLOB_DECODER_BY_TYPE = {
    'OSMHeader': proto.OSMPBF.HeaderBlock.decode,
    'OSMData': decodePrimitiveBlock
};

function createFileParser(fd, callback){
    readFileBlocks(fd, function(err, fileBlocks){
        if(err){
            return callback(err);
        }

        function findFileBlocksByBlobType(blobType){
            var blocks, i, block;

            blocks = [];

            for(i = 0; i < fileBlocks.length; ++i){
                block = fileBlocks[i];

                if(block.blobHeader.type !== blobType){
                    continue;
                }

                blocks.push(block);
            }

            return blocks;
        }

        function readBlob(fileBlock, callback){
            return reader.readPBFElement(fd, fileBlock.blobHeader.position, fileBlock.blobHeader.datasize, proto.OSMPBF.Blob.decode, callback);
        }

        function readBlock(fileBlock, callback){
            return readBlob(fileBlock, function(err, blob){
                if(err){
                    return callback(err);
                }

                if(blob.rawSize === 0){
                    return callback('Uncompressed pbfs are currently not supported.');
                }

                zlib.inflateBlob(blob, function(err, data){
                    if(err){
                        return callback(err);
                    }

                    return buf.readPBFElementFromBuffer(data, OSM_BLOB_DECODER_BY_TYPE[fileBlock.blobHeader.type], callback);
                });
            });
        }

        return callback(null, {
            fileBlocks: fileBlocks,

            findFileBlocksByBlobType: findFileBlocksByBlobType,

            readBlock: readBlock
        });
    });
}

module.exports = {
    parse: parse,

    createParser: createPathParser
};
