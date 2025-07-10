Great. I’ll investigate the OSM PBF format in full detail, including its structure down to the byte and bit level, how it can be parsed and written in JavaScript, and what each part of the Pitcairn Islands .osm.pbf file contains. I’ll explain the Protocol Buffers schema used, and walk through how different blocks and sections are laid out and recognized in the file.

I’ll let you know once everything is ready.

# OpenStreetMap PBF Format: Structure and JavaScript Parsing Guide

## Overview of OSM PBF (Protocolbuffer Binary Format)

OpenStreetMap’s PBF format is a compact binary encoding of map data, roughly half the size of gzipped XML ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=PBF%20format%20%28,support%20future%20extensibility%20and%20flexibility)). It uses Google Protocol Buffers (Protobuf) to encode map elements (nodes, ways, relations) efficiently. An OSM PBF file is essentially a sequence of *data blocks*, each wrapped with a small header. We will break down the file’s exact byte-level structure and demonstrate how to decode and encode it using JavaScript. For concreteness, we use the Pitcairn Islands extract (`pitcairn-islands-latest.osm.pbf`, ~100 KB) as a running example. This file is tiny but contains all OSM entity types (nodes, ways, and a relation), making it ideal for illustrating the format.

**Key goals:** We’ll describe the file format down to bits and bytes, explain Protobuf schema interpretation (fields, varints, ZigZag encoding), and give JavaScript-centric guidance for parsing and writing PBF data. The approach will emphasize functional, idiomatic JS patterns (using arrow functions and closures for state where needed) while ensuring an accurate low-level understanding.

## File Structure: Blocks, Headers, and Blobs

An OSM PBF file consists of a sequence of *blocks*. Each block has a short header (with metadata) and a blob (payload) containing the actual data. The structure repeats until EOF. In bytes, each block is organized as follows ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=The%20format%20is%20a%20repeating,sequence%20of)):

1. **Block Header Length (int32)** – A 4-byte unsigned integer in network byte order (big-endian) giving the size of the BlobHeader message that follows. 
2. **BlobHeader message** – A Protobuf message (of the given length) describing the blob’s type and size.
3. **Blob message** – A Protobuf message containing the actual data for this block, with length specified by the BlobHeader.

In the Pitcairn file, the very first 4 bytes form the length of the first BlobHeader. For example, if those bytes read `00 00 00 15` (21 in decimal), that means the BlobHeader is 21 bytes long. Immediately after those 4 bytes, the next 21 bytes encode the BlobHeader.

### BlobHeader Structure

The **BlobHeader** message tells us what kind of data to expect in the blob and how large it is. Its schema is (from the PBF spec) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=A%20BlobHeader%20is%20currently%20defined,as)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=following%20blob%2C%20%28e,message)):

```protobuf
message BlobHeader {
  required string type = 1;
  optional bytes indexdata = 2;
  required int32 datasize = 3;
}
```

- **`type`** – A string indicating the block type. For OSM data files, this is either `"OSMHeader"` for the file header block or `"OSMData"` for a block of OSM entities ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=,These%20contain%20the%20entities)). (Other types may be defined by extensions, but standard OSM files use these two.)
- **`indexdata`** – Optional arbitrary bytes, reserved for future use (e.g. could hold a spatial index). This is usually empty or omitted in .osm.pbf files (Pitcairn has no indexdata).
- **`datasize`** – An int32 giving the size in bytes of the following Blob message. This *datasize* is the length of the serialized Blob (after the BlobHeader), not the uncompressed data size ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=,message)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Blob%20,When%20compressed%2C%20the%20uncompressed%20size)).

In our example file, the first BlobHeader will have `type = "OSMHeader"` and `datasize` equal to the size of the header blob. We can identify it by reading the BlobHeader bytes. For instance, decoding those bytes might yield: type = `"OSMHeader"`, datasize = 1234 (hypothetical). The presence of `"OSMHeader"` tells us this block contains file header info, not map elements.

After the header, subsequent blocks will have BlobHeaders with `type = "OSMData"` (meaning they contain actual map data). Each block’s BlobHeader is immediately followed by its Blob data of length `datasize`. The parser should loop reading 4-byte lengths and BlobHeaders until EOF.

### Blob Structure and Compression

The **Blob** message holds the raw or compressed data. Its schema (simplified) is ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Blob%20,When%20compressed%2C%20the%20uncompressed%20size)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=number)):

```protobuf
message Blob {
  optional int32 raw_size = 2;          // Uncompressed size, if compressed
  oneof data {
    bytes raw = 1;                     // Uncompressed data
    bytes zlib_data = 3;               // Deflate-compressed data
    bytes lz4_data = 6;                // LZ4-compressed data (optional)
    bytes zstd_data = 7;               // Zstd-compressed data (optional)
    /* ... (fields for other compression types, e.g. OBSOLETE_bzip2) ... */
  }
}
```

If the blob is uncompressed, it will contain the `raw` field (field 1) with the data bytes, and no `raw_size`. If compressed (e.g. with zlib DEFLATE, the most common case), the blob will have a `zlib_data` field (field 3) and a `raw_size` field indicating how many bytes the data will be when decompressed ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Blob%20,When%20compressed%2C%20the%20uncompressed%20size)). All OSM readers/writers must support raw and zlib compression, and typically Osmosis/Osmium will compress each block with zlib by default ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=)). Other compression types (LZ4, Zstd) are less common.

**Example:** In the Pitcairn PBF, the header block is small and likely compressed. The BlobHeader for the header might say `datasize = 120` bytes. Parsing that Blob, we expect to find a `raw_size` (e.g. ~110 bytes) and a `zlib_data` field containing ~120 bytes of compressed data ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000010%20%207c%20,length%20120%20bytes)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=,z.E)). The magic bytes `0x78 0x9C` at the start of `zlib_data` indicate the zlib stream (0x78 0x9C is a common deflate header) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=,a.zfJ%5C..y)). A decoder will inflate those bytes to get the original uncompressed data of length `raw_size`. Each OSMData block in Pitcairn is also zlib-compressed in the same manner. The Blob’s `raw_size` helps allocate a buffer for decompression and acts as a check (the decompressed data length must match).

In summary, to read a block: first parse BlobHeader (get `type` and `datasize`), then read exactly `datasize` bytes for the Blob, then inside Blob check if data is raw or compressed. Decompress if needed to obtain the actual payload bytes for that block.

## OSMHeader Block: File Header Content

The first block in any .osm.pbf is an **OSMHeader** block. After decompressing the Blob, we get a Protobuf message of type `HeaderBlock`. This contains metadata about the file, such as the map data’s bounding box, required features, and optionally replication update info. The `HeaderBlock` schema is defined in `osmformat.proto` ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20HeaderBlock%20,repeated%20string%20optional_features%20%3D%205)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20replication%20timestamp%2C%20expressed%20in,optional%20int64%20osmosis_replication_timestamp%20%3D%2032)):

```protobuf
message HeaderBlock {
  optional HeaderBBox bbox = 1;
  repeated string required_features = 4;
  repeated string optional_features = 5;
  optional string writingprogram = 16;
  optional string source = 17;
  optional int64 osmosis_replication_timestamp = 32;
  optional int64 osmosis_replication_sequence_number = 33;
  optional string osmosis_replication_base_url = 34;
}
message HeaderBBox {            // sub-message for bbox
  required sint64 left   = 1;
  required sint64 right  = 2;
  required sint64 top    = 3;
  required sint64 bottom = 4;
}
```

Key fields in **HeaderBlock**:

- **`bbox`**: The bounding box of the data (if provided). It gives left, right, top, bottom in **nanodegree** units (1e-9 degrees) using `sint64` (zigzag-encoded) values ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20HeaderBlock%20,repeated%20string%20optional_features%20%3D%205)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20HeaderBBox%20,sint64%20bottom%20%3D%204%3B)). For example, Pitcairn Islands (around 24°30′S, 128°W) might have `left ≈ -128000000000` and `top ≈ -24500000000` (values scaled by 1e9). Decoding these yields the lat/lon extents of the extract.
- **`required_features`**: A list of strings indicating features that *must* be supported to correctly parse the file ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Currently%20the%20following%20features%20are,defined)). Standard OSM PBFs always include at least `"OsmSchema-V0.6"` (denoting the OSM data model v0.6) and usually `"DenseNodes"` (indicating that nodes use the DenseNodes format) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Currently%20the%20following%20features%20are,defined)). If a parser doesn’t understand any required feature, it must refuse the file. In Pitcairn’s header, we expect to see:
  - `"OsmSchema-V0.6"` – the data conforms to OSM XML schema v0.6 (the current version) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Currently%20the%20following%20features%20are,defined)).
  - `"DenseNodes"` – nodes are stored in the dense format (discussed later) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Currently%20the%20following%20features%20are,defined)).
  - (Pitcairn likely doesn’t require `"HistoricalInformation"` since it’s a current snapshot, not a full history file. That feature is used when deleted objects are included with `visible=false` flags ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20The%20visible%20flag%20is,%2F%2F%20set)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20If%20visible%20is%20set,bool%20visible%20%3D%206%3B)).)
- **`optional_features`**: A list of strings for optional features that a parser *can* use if known, but can be safely ignored ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=In%20addition%2C%20a%20file%20may,following%20features%20have%20been%20proposed)). For example, `"Has_Metadata"` could appear to hint that metadata (user names, timestamps, etc.) are included. Geofabrik extracts typically include full metadata, but they have not standardized on adding `"Has_Metadata"` tag (that was only a proposed feature). Another optional feature is `"LocationsOnWays"` (if node coordinates were embedded in way structures) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20If%20this%20is%20used%2C,DELTA%20coded%2C%20optional)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2A%20%60%22timestamp%3D2011,See%20Ways%20and%20Relations%20below)), which is not the case here.
- **`writingprogram`**: A free-form string identifying the software that wrote the file ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=repeated%20string%20optional_features%20%3D%205%3B)). For instance, it might be `"osmium/1.5.1"` or `"Osmosis 0.48"` etc. The Pitcairn file is from Geofabrik’s pipeline – often they use **Osmium** library, so this might read something like `"Osmium/X.Y.Z"` or a snapshot tag.
- **`source`**: A free-form string (often empty). Sometimes this duplicates the API version or origin of data. For example, in some files this is `"OpenStreetMap server"` or an OSM API URL. In the Bremen example, `source` was `"https://www.openstreetmap.org/api/0.6"` ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000040%20%2048%204f%2054,decompressed)).
- **Replication fields** (`osmosis_replication_timestamp`, `..._sequence_number`, `..._base_url`): These fields are used if the file is a snapshot that can be updated with diff files ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=The%20%60osmosis_replication_,synchronisation%20point%20can%20be%20found)). They correspond to the state of an Osmosis updates feed. Geofabrik extracts typically include these so that consumers know up to what point the data is current and where to fetch updates ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=The%20%60osmosis_replication_,synchronisation%20point%20can%20be%20found)). In Pitcairn’s header, we expect:
  - `osmosis_replication_timestamp`: The Unix epoch time (in seconds) of the snapshot’s last update. This tells when the extract was last synced with OSM. (For example, it might be something like `1696521600` for a file from Oct 5, 2023, etc.)
  - `osmosis_replication_sequence_number`: An integer sequence number for the diff stream.
  - `osmosis_replication_base_url`: URL of the updates feed. Geofabrik includes their regional update service here. For Pitcairn, it should be something like `"http://download.geofabrik.de/australia-oceania/pitcairn-islands-updates"` (this base URL provides increment diffs to update the extract) ([pyosmium-up-to-date objects in output seem to heavily depend on replication server · Issue #103 · osmcode/pyosmium · GitHub](https://github.com/osmcode/pyosmium/issues/103#:~:text=Let%27s%20say%20I%20downloaded%20the,It%27s%20about%2053%20MB)).

**How to interpret the HeaderBlock:** A parser reading Pitcairn’s HeaderBlock will gather that it must support DenseNodes (which we will handle), that the data schema is OSM v0.6 (which is standard), and that metadata is included (even if not explicitly flagged, we’ll see user information in the data). It also provides the area bounds (so we know which region it covers) and gives the replication timestamp & URL (so one could use OSM diff files to update beyond that timestamp).

*Example:* Decoding Pitcairn’s header might yield: a bbox roughly covering latitude ~-25 to -23 and longitude ~-130 to -127, `required_features = ["OsmSchema-V0.6","DenseNodes"]`, `writingprogram = "osmium/1.5.1"`, `source = "OpenStreetMap API 0.6"`, and `osmosis_replication_*` fields indicating when and where to get updates. All this comes from a few dozen bytes of the header blob.

After the HeaderBlock is parsed, the next block in the file will be an `"OSMData"` block containing the actual map elements.

## OSMData Blocks: PrimitiveBlock and PrimitiveGroup

All blocks with `type = "OSMData"` contain OSM map elements (nodes, ways, relations). Each such block, after decompression, is a **PrimitiveBlock** message. This is where the bulk of data resides. The PrimitiveBlock is defined as ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20PrimitiveBlock%20,repeated%20PrimitiveGroup%20primitivegroup%20%3D%202)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=optional%20int64%20lat_offset%20%3D%2019,default%3D0)):

```protobuf
message PrimitiveBlock {
  required StringTable stringtable = 1;
  repeated PrimitiveGroup primitivegroup = 2;
  optional int32 granularity = 17 [default = 100];
  optional int64 lat_offset = 19 [default = 0];
  optional int64 lon_offset = 20 [default = 0];
  optional int32 date_granularity = 18 [default = 1000];
  // (potentially an optional bbox field in future)
}
```

Key parts of **PrimitiveBlock**:

- **`stringtable`** – A **StringTable** message (field 1) containing all unique strings (tag keys, tag values, user names, role names, etc.) used in that block ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=When%20creating%20a%20PBF%20file%2C,compressibility%20of%20the%20stringtable%20if)). Instead of storing repeated text, the PBF uses indexes into this table. The first entry of the string table is always the empty string (index 0) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=When%20creating%20a%20PBF%20file%2C,have%20the%20same%20frequency%20lexicographically)), reserved as a delimiter (explained below). All real strings (like `"name"` or `"highway"` or `"Pitcairn Islands"`) occupy subsequent indices. The string table is shared by all entities in the block.
- **`primitivegroup`** – A list of one or more **PrimitiveGroup** messages (field 2). Each PrimitiveGroup holds a collection of OSM entities of a single type. In other words, one group might contain nodes, another group ways, another relations, etc., but they won’t mix types in one group ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=)). This segmentation ensures entities come out in the original order they were written. Typically, Osmosis/Osmium will put up to ~8000 entities per group ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=A%20block%20may%20contain%20any,8000%20when%20writing%20PBF%20format)) and group by type. In Pitcairn’s case, because the dataset is very small, we might have just **one PrimitiveGroup for nodes, one for ways, and one for relations** in the single PrimitiveBlock. The groups appear in the file in the same order as their entity types were originally output (usually nodes first, then ways, then relations, preserving OSM’s natural order).
- **`granularity`** – Unit resolution for coordinate values, in nanodegrees. Default is 100 nanodegrees (1e-7 degrees) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=handle%20multiple%20resolutions%2C%20the%20granularity%2C,This%20is%20the)) ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=optional%20int32%20granularity%20%3D%2017,default%3D1000)). Coordinates stored in the file are integer values representing **latitude/longitude in units of this granularity**. With the default 100, an integer `lat = 123456789` corresponds to `123456789 * 1e-7 = 12.3456789` degrees. Granularity allows trading off precision vs file size; OSM uses 1e-7 (about 1 cm precision) as default. Pitcairn’s file uses the default granularity (100) since no override is indicated (the default is used when the field is omitted) ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=match%20at%20L1554%20In%20this,for%20lat%20and%20lon%20offsets)).
- **`lat_offset`, `lon_offset`** – Offsets added to coordinates. Default 0 (meaning coordinates are absolute in the global datum) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=granularity%20grid%2C%20in%20units%20of,default%3D0)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20Offset%20value%20between%20the,default%3D0)). These offsets are rarely used except for special tiling scenarios. They allow shifting all coordinates by a fixed amount before applying granularity. In most extracts (including Pitcairn), `lat_offset = lon_offset = 0` ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=match%20at%20L1554%20In%20this,for%20lat%20and%20lon%20offsets)), so we can ignore them. (If they were non-zero, you would add them *before* multiplying by granularity when converting to degrees ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=In%20addition%20to%20granularity%2C%20the,be%20added%20to%20each%20coordinate)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=latitude%20%3D%20.000000001%20,lon)).)
- **`date_granularity`** – Unit resolution for timestamps, in milliseconds. Default 1000 (i.e. timestamps in units of seconds) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=match%20at%20L384%20%2F%2F%20Granularity,default%3D1000)) ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=We%20still%20have%20to%20check%2C,date_granularity)). This applies to object timestamp fields (in the `Info` metadata, discussed later). Default 1000 means if a node’s timestamp value is `1640995200`, that actually represents 1640995200 * 1000 = 1.6409952e12 ms since epoch (which is Jan 1 2022). The Pitcairn file uses the default, meaning timestamps are stored as Unix epoch seconds.

**Coordinate decoding:** To get actual latitude/longitude in degrees for a node, use: 

```
latitude = 0.000000001 * (lat_offset + granularity * lat_value)
longitude = 0.000000001 * (lon_offset + granularity * lon_value)
``` 

with all terms integers ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=In%20addition%20to%20granularity%2C%20the,be%20added%20to%20each%20coordinate)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=latitude%20%3D%20.000000001%20,lon)). With defaults, this simplifies to `1e-9 * (0 + 100 * lat)` = `1e-7 * lat`. So if `lat_value = -245000000` for example, the lat in degrees = -24.5°. The multiplication and addition are done in integer math internally, so the precision is exact to the nanodegree.

In Pitcairn’s data, we’ll apply this formula after decoding raw lat/lon integers. We expect values around -24.5 (lat) and -128 (lon) degrees for Pitcairn nodes.

### StringTable and Tag Encoding

The **StringTable** (embedded in PrimitiveBlock) simply contains a repeated field of strings (let’s call it `repeated bytes s = 1` in the schema). The first entry is an empty string `""` ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=When%20creating%20a%20PBF%20file%2C,have%20the%20same%20frequency%20lexicographically)). All other strings (tag keys, tag values, etc.) are stored exactly once here. Every time a tag or user or role appears on an object, the PBF stores an index into this string table instead of the literal text. This greatly reduces size (keys/values are reused many times).

For example, if the string `"name"` is at index 5 in the table and `"Pitcairn Islands"` is at index 42, then a node with a `name=Pitcairn Islands` tag will store the pair (5, 42) to represent that tag. The consumer will lookup index 5 -> `"name"`, 42 -> `"Pitcairn Islands"` to reconstruct the tag. The string table is common to the whole block, so indices apply across all groups in that block.

**Index 0 is reserved as a delimiter.** It is guaranteed to be the empty string and *not used for actual tag text* ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=When%20creating%20a%20PBF%20file%2C,have%20the%20same%20frequency%20lexicographically)). The reason: in the DenseNodes format (see below), tags for multiple nodes are concatenated in one array with 0 as a separator between nodes. If index 0 were a meaningful string, it would conflict with its role as a terminator. So encoders **always put an empty string at 0** and never use it for real data.

The Pitcairn file’s string table will include entries for things like `"name"`, `"place"`, `"boundary"`, `"administrative"`, `"outer"`, `"label"`, `"admin_centre"`, etc., as well as names of the islands and possibly user names of contributors. Each appears once in the table. The parser will build an array of these strings for quick reference.

### PrimitiveGroup and Entity Types

Inside each PrimitiveBlock, we have one or more **PrimitiveGroup** messages (the `primitivegroup` field). A PrimitiveGroup contains OSM entities of **only one type** (node, way, relation, or changeset) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=)). The schema is ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20PrimitiveGroup%20,ChangeSet%20changesets%20%3D%205%3B)):

```protobuf
message PrimitiveGroup {
  repeated Node nodes = 1;
  optional DenseNodes dense = 2;
  repeated Way ways = 3;
  repeated Relation relations = 4;
  repeated ChangeSet changesets = 5;
}
```

Only one of these fields will be used in any given group (the others will be empty/default). If `dense` is set, then `nodes` will be empty, and vice versa ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=)). This design is to avoid interleaving different entity types which could mess up ordering ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=A%20,be%20rather%20confusing%20to%20users)).

Thus, to interpret a PrimitiveGroup, you check which field is populated:

- If `dense` exists, this group contains nodes in DenseNodes format (most common for modern data).
- Otherwise, if `nodes` list is non-empty, it contains individual Node messages (older format, rarely used if DenseNodes is available).
- If `ways` list is non-empty, it’s a ways group.
- If `relations` non-empty, a relations group.
- `changesets` are rarely present in planet extracts (they would be if distributing OSM changesets data; not applicable to typical map PBF).

For Pitcairn, we anticipate one **dense node group**, one **ways group**, and one **relations group**. The order in the file should be nodes (dense), then ways, then relations, matching the original data order. Each group is a sub-message within the PrimitiveBlock’s byte stream.

Now, let’s detail each entity type encoding:

#### Nodes (and DenseNodes)

Nodes (points with latitude, longitude and tags) can be stored in two ways: as a repeated list of full `Node` messages, or in a compact `DenseNodes` representation ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Nodes%20can%20be%20encoded%20one,coding%20to%20work%20very%20effectively)). Since the required feature `"DenseNodes"` is present, Pitcairn’s nodes will use the dense format (this is almost always the case for PBFs today, as it’s much more efficient).

**Node message format (non-dense):** For reference, a `Node` message contains: an ID, zero or more tags, optional metadata, and the coordinate. In proto form, it looks like (from the spec):

```protobuf
message Node {
  required int64 id = 1;
  repeated uint32 keys = 2 [packed = true];
  repeated uint32 vals = 3 [packed = true];
  optional Info info = 4;
  required int64 lat = 8;
  required int64 lon = 9;
}
```

- `id` = node ID (global OSM ID).
- `keys` and `vals` = parallel arrays of indexes into the string table for tag keys and values. They have the same length; e.g. if keys=[5,7] and vals=[12, 20], that means the node has two tags: (stringTable[5] = key1, stringTable[12] = val1) and (stringTable[7] = key2, stringTable[20] = val2). If a node has no tags, these arrays are empty (or omitted).
- `info` = optional Info message (with version, timestamp, user, etc.) for metadata.
- `lat`, `lon` = the node’s coordinates as int64. These are **already offset by lat_offset/lon_offset and divided by granularity**, i.e. the stored `lat` = (node_latitude_deg * 1e9 - lat_offset) / granularity. In practice with default granularity and offset, `lat` = floor(node_lat_deg * 1e7). (These are not delta-coded between nodes; each node stores absolute coordinate in the block’s reference frame.)

However, **Node messages are seldom used** in modern .osm.pbf because DenseNodes is much more compact. Instead of repeating the field tags (id, lat, lon, etc.) for each node, DenseNodes packs all node data into a few big arrays, exploiting that many values (especially IDs and coordinates) are similar to the previous node’s.

**DenseNodes format:** The DenseNodes message (when `PrimitiveGroup.dense` is set) is defined as ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20DenseNodes%20,%2F%2F%20DELTA%20coded)):

```protobuf
message DenseNodes {
  repeated sint64 id = 1 [packed = true];       // delta-coded
  optional DenseInfo denseinfo = 5;
  repeated sint64 lat = 8 [packed = true];      // delta-coded
  repeated sint64 lon = 9 [packed = true];      // delta-coded
  repeated int32 keys_vals = 10 [packed = true];
}
```

All nodes in the group are represented by parallel arrays: one for IDs, one for lats, one for lons, and one combined array for tags. “Delta-coded” means that instead of storing actual values, each entry (after the first) is stored as the difference from the previous value. The `sint64` type means these differences are ZigZag-encoded (more on that in *Bit-level Details* section). The first element is the delta from 0, so effectively the first element is the actual value.

- `id`: an array of **signed** ints. The first element is the first node’s ID. The second element is (second node’s ID – first node’s ID), the third is (third node’s ID – second node’s ID), etc. ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20DenseNodes%20,%2F%2F%20DELTA%20coded)). This exploits the fact that node IDs in OSM often increase (they’re sorted by insertion order, which is roughly increasing ID, though not strictly sorted globally in extracts). Even if not strictly increasing, delta coding still works (differences might be negative if a smaller ID comes after a larger one, but ZigZag handles that).
- `lat` and `lon`: arrays of signed ints for coordinates, delta-encoded similarly. The first `lat` entry is the first node’s latitude value (scaled int as per granularity). The next `lat` entry is (second node’s lat_value – first node’s lat_value), etc. ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20DenseNodes%20,%2F%2F%20DELTA%20coded)). Same for `lon`. Because neighboring nodes (especially within the same dataset region) tend to be close on the earth, these deltas are often small, making for very compact varints.
- `keys_vals`: this is a single **concatenated list of tag keys and values for all nodes**, with **0 as a delimiter** between nodes ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Keys%20and%20values%20for%20all,delimiters%2C%20but%20is%20simply%20empty)). Each node’s tags are encoded as a sequence: `[keyIndex1, valueIndex1, keyIndex2, valueIndex2, ..., 0]`. A `0` marks the end of one node’s tags and the beginning of the next node’s tags. If a node has no tags, its sequence is just a single `0` (immediately ends). The `keys_vals` array as a whole is packed (no per-value tags, just one length and then many int32 entries). Note that `0` is guaranteed to be the empty string index, not a real key or value, so it safely signifies “end of tags” ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Keys%20and%20values%20for%20all,delimiters%2C%20but%20is%20simply%20empty)). In Pitcairn’s data, many nodes (like untagged points along coastlines) have no tags, so you will see runs of `0` delimiters in `keys_vals`. Nodes that do have tags (like the one with `name=Pitcairn Islands` or the one for `place=Town (Adamstown)`) will have their key and value indices in between the 0’s.
- `denseinfo`: an optional sub-message that, if present, contains parallel arrays for metadata (version, timestamp, changeset, user id, etc.) for each node ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=,coding%20on%20metadata)). Since Pitcairn is a normal extract with metadata, `denseinfo` *will be present* (because Geofabrik includes user and timestamp data). The `DenseInfo` message looks like:
  ```protobuf
  message DenseInfo {
    repeated int32 version = 1 [packed = true];
    repeated sint64 timestamp = 2 [packed = true];   // delta-coded
    repeated sint64 changeset = 3 [packed = true];   // delta-coded
    repeated sint32 uid = 4 [packed = true];         // delta-coded
    repeated sint32 user_sid = 5 [packed = true];    // delta-coded (indexes into stringtable for username)
    repeated bool visible = 6 [packed = true];
  }
  ```
  Each array in DenseInfo aligns with the nodes array by index. `version[i]` is the version number of the i-th node, `timestamp[i]` is the delta from previous node’s timestamp (in units of date_granularity), etc. `user_sid` is the index in the string table for the username; it’s delta-coded as well (since often the same user repeats for consecutive nodes, they might store 0 when the user is the same as the last node’s user) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20DenseInfo%20,DELTA%20coded)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=repeated%20sint64%20changeset%20%3D%203,DELTA%20coded)). `visible` is used only for historical data (it marks if the object was visible or deleted) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20The%20visible%20flag%20is,%2F%2F%20set)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20If%20visible%20is%20set,bool%20visible%20%3D%206%3B)) – in a snapshot like Pitcairn, either this field is omitted entirely or all values are `true` by default. The presence of `DenseInfo` indicates that the file has metadata (“Has_Metadata”), though they didn’t need an explicit optional_feature tag for it. We will parse DenseInfo similarly to DenseNodes: treat each field’s array and reconstruct actual values by accumulating deltas.

**Decoding DenseNodes (illustrative):** Suppose after parsing the varint streams we obtain (for a tiny example) `id = [10, 2, 3]`, `lat = [100000000, 500, 500]`, `lon = [-200000000, 100, 100]`, and `keys_vals = [ 15, 16, 0,  0,  27, 28, 29, 30, 0 ]`. This means:
- id array decoded: first id = 10, second id delta = 2 (so actual second id = 10+2 = 12), third id delta = 3 (so third id = 12+3 = 15).
- lat array: first lat = 100000000, second delta = 500 (second lat = 100000500), third delta = 500 (third lat = 100001000). If granularity=100, these correspond to 10.0000000°, 10.0000500°, 10.0001000°.
- lon array: first lon = -200000000, second delta = 100 (→ -199999900), third delta = 100 (→ -199999800). As degrees: -20.0000000°, -19.9999900°, -19.9999800°.
- keys_vals: For node0: `[15,16, 0]` meaning one tag (key=15, val=16) then terminator. Node1: `[0]` meaning no tags (just terminator). Node2: `[27,28, 29,30, 0]` meaning two tags: (27→key,28→val) and (29→key,30→val).

A decoding function would iterate through `id`, accumulating to get each actual ID, do likewise for lat and lon, then iterate through the `keys_vals` sequence, splitting on 0 to assign tag lists to each node. The resulting node objects might be:
- Node ID 10 @ (lat=10°, lon=-20°) with tag stringTable[15] = stringTable[16] (one k/v pair).
- Node ID 12 @ (10.00005°, -19.99999°) with no tags.
- Node ID 15 @ (10.00010°, -19.99998°) with two tags (stringTable[27]=stringTable[28], stringTable[29]=stringTable[30]).

In Pitcairn’s case, the dense node group will contain possibly a few hundred nodes (coastline points and a few POIs). The `keys_vals` array will be mostly zeros, except for entries for the handful of tagged nodes (like the island label node, etc.). The DenseInfo will provide each node’s version (likely 1 for most), timestamp (all nodes will have a timestamp, delta-encoded; since many nodes were likely created at the same time, some deltas could be small), changeset ID (also delta-encoded), and user IDs/names (likely only a couple of unique users). 

#### Ways

A **Way** in OSM is a sequence of node references with tags (e.g. a road or polygon outline). In PBF, each Way is a message with the following fields ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Way%20,packed%20%3D%20true)):

```protobuf
message Way {
  required int64 id = 1;
  repeated uint32 keys = 2 [packed = true];
  repeated uint32 vals = 3 [packed = true];
  optional Info info = 4;
  repeated sint64 refs = 8 [packed = true];  // delta-coded node IDs
  // optional: repeated sint64 lat = 9 [packed = true];
  // optional: repeated sint64 lon = 10 [packed = true];
}
```

- `id`: the way’s OSM ID.
- `keys` / `vals`: parallel arrays of string table indices for tag keys and values (just like Node above). If a way has no tags, these would be empty/omitted.
- `info`: optional metadata (same structure as Node’s Info but for a way).
- `refs`: an array of **signed** ints (delta-encoded) for the node IDs comprising the way’s geometry ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=For%20ways%20and%20relations%2C%20which,IDs%20of%20the%20values)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=repeated%20uint32%20vals%20%3D%203,packed%20%3D%20true)). The first value is the first node ID, subsequent values are differences. This is analogous to DenseNodes id list, but scoped per way. By delta-encoding node IDs, if a way’s nodes are close in ID or sequential, it compresses well. Note: Node IDs in a way are not sorted; they are in the order that defines the path. Deltas can be negative if a way refers to a smaller ID after a larger one, but often in OSM, ways list nodes in the order they were added – which could be somewhat sequential if nodes were created in sequence. Regardless, the decoder must accumulate the deltas to get each referenced node ID in the way.
- `lat` / `lon`: These fields (9 and 10) are *optional* and not normally present. They would contain parallel coordinate lists for the way’s nodes, delta-encoded like DenseNodes. This is an optional feature called **LocationsOnWays** ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20The%20following%20two%20fields,DELTA%20coded%2C%20optional)). It is rarely used (because it duplicates data – normally you get node coordinates by looking up the node IDs). We won’t see these in Pitcairn, since the file doesn’t list `"LocationsOnWays"` as a required or optional feature in the header, and Geofabrik extracts do not use it. We mention it for completeness: if present, each way would carry lat/lon info for each ref, which must match the count of refs ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20If%20this%20is%20used%2C,DELTA%20coded%2C%20optional)).

A PrimitiveGroup of ways contains a *repeated list of Way messages*. They are not packed into one big blob; each Way appears with its own length in the Protobuf stream. But because `keys`, `vals`, and `refs` inside each Way are packed, the overhead per tag and per ref is minimized.

**Decoding Way refs:** The algorithm is: start with `accumulator = 0`; for each varint in the `refs` array, ZigZag-decode it to a signed delta, then `accumulator += delta`, and output `accumulator` as the next node ID. For example, if a way’s stored refs = `[1001, 2, 2, 129]` (varints representing signed deltas): decode to deltas [1001, 2, 2, -65] (assuming 129 encodes -65 via ZigZag), then accumulate: first node ID = 1001, next = 1003, next = 1005, next = 940. That would mean the way’s node IDs are [1001, 1003, 1005, 940] – notice the last one is lower, which can happen if the way loops back to a previously created node. Delta encoding handled it with a negative jump.

In Pitcairn’s data, an example Way is likely the coastline. The coastline might be split into several Way segments (as indicated, Pitcairn relation had 4 outer ways). Each of those ways will have a list of refs. If a coastline way has (say) 100 nodes, instead of storing 100 full 64-bit IDs, the PBF will store one full ID and 99 small deltas (mostly small differences as the IDs might be contiguous or nearly so if the nodes were created together). The parser will reconstruct the full list of node IDs for that way. Then, typically one would use those IDs to look up the actual node coordinates (which we would have decoded from the DenseNodes group earlier).

The Way’s tags are decoded by mapping `keys` and `vals` indices to strings just like for nodes. Way metadata (Info) is decoded similarly to node Info (we’ll describe Info after relations).

#### Relations

A **Relation** is a multi-member group of objects, each with a role. For example, Pitcairn Islands relation (ID 2185375) has members: 4 ways (each an outer boundary) and 2 node members (one label node, one admin_centre node). Relations can also contain other relations as members. The PBF encodes relations as follows ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Relation%20,required%20int64%20id%20%3D%201)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=optional%20Info%20info%20%3D%204%3B)):

```protobuf
message Relation {
  enum MemberType { NODE = 0; WAY = 1; RELATION = 2; }
  required int64 id = 1;
  repeated uint32 keys = 2 [packed = true];
  repeated uint32 vals = 3 [packed = true];
  optional Info info = 4;
  repeated int32 roles_sid = 8 [packed = true];
  repeated sint64 memids = 9 [packed = true];     // delta-coded member IDs
  repeated MemberType types = 10 [packed = true];
}
```

- `id`: the relation’s OSM ID.
- `keys` / `vals`: tag keys and values (just like nodes/ways).
- `info`: optional metadata (same structure).
- `roles_sid`: an array of **indexes into the string table** for member role strings ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=optional%20Info%20info%20%3D%204%3B)). Each member in the relation has a role (possibly empty role `""`). Instead of storing the role text, they store the string table index (sid = string ID). These are not delta-coded (just raw uint32 indices) but they are packed. Each index corresponds to one member.
- `memids`: an array of **signed 64-bit** integers (delta-encoded) for member IDs ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=optional%20Info%20info%20%3D%204%3B)). The first value plus some base = first member’s OSM ID, subsequent values are differences from previous member’s ID. The base for first is 0 (so first memid is actual first member ID).
- `types`: an array of MemberType enums (0=Node, 1=Way, 2=Relation) for each member ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Relation%20,required%20int64%20id%20%3D%201)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20Parallel%20arrays%20repeated%20int32,packed%20%3D%20true%5D%3B)).

All three arrays `roles_sid`, `memids`, and `types` have the same length, equal to the number of members in the relation. The *i*-th elements of each correspond to the *i*-th member. For example, if `roles_sid = [5, 5, 5, 5, 6, 7]`, `memids = [1000, 10, 10, 20, 500, 30]` (varint-encoded values), and `types = [1,1,1,1,0,0]`, this describes a relation with 6 members:
  - Member 1: role = stringTable[5], type=Way (1), ID = 1000 (since first memid delta = 1000 from 0).
  - Member 2: role = stringTable[5] (same role), type=Way, ID = 1010 (prev ID 1000 + delta 10).
  - Member 3: role = stringTable[5], type=Way, ID = 1020 (1010 + 10).
  - Member 4: role = stringTable[5], type=Way, ID = 1040 (1020 + 20).
  - Member 5: role = stringTable[6], type=Node (0), ID = 1540 (1040 + 500).
  - Member 6: role = stringTable[7], type=Node, ID = 1570 (1540 + 30).

In a real scenario, stringTable[5] might be `"outer"`, [6] = `"label"`, [7] = `"admin_centre"`. So this example relation would have 4 outer ways and 2 node members with roles label and admin_centre – which matches Pitcairn’s structure, actually. Indeed, Pitcairn Islands relation has 6 members: 4 outer ways and 2 nodes (one label, one admin_centre) ([Relation: ‪Pitcairn Islands‬ (‪2185375‬) | OpenStreetMap](https://www.openstreetmap.org/relation/2185375#:~:text=6%20members)) ([Relation: ‪Pitcairn Islands‬ (‪2185375‬) | OpenStreetMap](https://www.openstreetmap.org/relation/2185375#:~:text=Way%20934644129%20as%20outer)). So we’d expect its Relation message to decode to something very similar: `roles_sid` containing several repeats of the index for `"outer"`, then indices for `"label"` and `"admin_centre"`; `types` containing four 1’s (Way) and two 0’s (Node); and `memids` where the first delta is the ID of the first outer way, next three deltas give the other way IDs, then deltas for the node IDs. The actual numeric values depend on the specific OSM IDs, but the pattern will match.

**Info (Metadata) for Nodes/Ways/Relations:** Each Node, Way, Relation may have an `Info` message if metadata is included. The Info message (for non-dense storage) has fields ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Info%20,5%3B%20%2F%2F%20String%20IDs)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20When%20a%20writer%20sets,bool%20visible%20%3D%206%3B)):

```protobuf
message Info {
  optional int32 version = 1 [default=-1];
  optional int32 timestamp = 2;
  optional int64 changeset = 3;
  optional int32 uid = 4;
  optional int32 user_sid = 5;
  optional bool visible = 6;
}
```

Meaning:
- `version`: the object’s version number (as in OSM history). -1 if not set.
- `timestamp`: time of last edit, in units of date_granularity since epoch. With default date_granularity=1000, this is seconds since epoch.
- `changeset`: the changeset ID of last edit.
- `uid`: user ID of last editor.
- `user_sid`: index in string table for the username of last editor.
- `visible`: (for history files) if false, this version was generated by a deletion. In current snapshots, `visible` is typically true for all objects and often omitted entirely. It’s only meaningful when `HistoricalInformation` feature is used ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20The%20visible%20flag%20is,%2F%2F%20set)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20If%20visible%20is%20set,bool%20visible%20%3D%206%3B)).

In Pitcairn’s extract (a snapshot of current data), all objects are visible (no deletions in the extract), so `visible` will either be true or omitted. The Info fields will be present for each object unless Geofabrik stripped them (unlikely). So we’ll see version (likely 1 for most objects in a small place), timestamps (probably all around the date the island was last edited), and user information. The string table will contain the usernames of contributors (for Pitcairn, perhaps a handful of mapper names). If a user appears in multiple objects, the same `user_sid` will be reused.

#### Putting it Together (Pitcairn Example Content)

To summarize the Pitcairn file structure in logical terms: after the header, there is likely **one PrimitiveBlock**. In that block, the `stringtable` contains all unique strings (tag keys/values, user names, role strings). Then we have multiple PrimitiveGroups:

- **Group 1: DenseNodes** – containing all nodes (coordinate points). Most of these are coastline nodes (untagged), plus a few tagged nodes (e.g. one for the island label, one for the settlement). We decode this by reading the dense arrays: get all node IDs (should correspond to OSM node IDs in Pitcairn), each node’s lat/lon (we convert them to degrees using the formula), and assign tags via the keys_vals list. Because required_features included `"DenseNodes"`, we know this group is present ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Currently%20the%20following%20features%20are,defined)), and indeed the Blob’s data will have a DenseNodes section (we can detect it by encountering field 2 in PrimitiveGroup) ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=optional%20DenseNodes%20dense%20%3D%202%3B)).
- **Group 2: Ways** – containing all ways. For Pitcairn, that includes the coastline segments (outer boundaries) and any other linear features (roads, footpaths, etc., if any) and closed polygons (maybe none besides coastline). Each way’s refs will reference node IDs that were listed in the DenseNodes group. We decode those IDs by summing deltas. We’ll also decode each way’s tags.
- **Group 3: Relations** – containing the Pitcairn Islands relation (admin boundary). Possibly this is the only relation. We decode its members (four way IDs and two node IDs) from memids and types, and roles from roles_sid. We expect to reconstruct that it has members = those way IDs (outer) and node IDs (label, admin_centre) with the correct roles.

No **ChangeSet** group is expected in this file (changesets are not part of snapshot map data; they’d appear only in a changeset dump file, which this is not).

Each PrimitiveGroup’s content can be identified by the presence of its first field tag. For instance, when parsing the PrimitiveBlock, after reading the stringtable, the next byte will indicate the start of a PrimitiveGroup. If that byte corresponds to field number 2 (wire type 2) – that is the `dense` field – we know this group is DenseNodes ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=match%20at%20L896%20)). After parsing DenseNodes, the next group might start with field 3 (ways) or 4 (relations), etc. In Pitcairn’s file, we would see something like: PrimitiveGroup1 starts with tag `0x12` (meaning field2 length-delimited) implying DenseNodes ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=optional%20DenseNodes%20dense%20%3D%202%3B)), then later a PrimitiveGroup starting with tag `0x1A` (field3, ways), and then one with `0x22` (field4, relations) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000090%20%20__%20__%2007,length%2087944%20bytes)).

Finally, note that **all numeric values (ids, coordinates, etc.) are stored as varints and often delta-coded, and many fields are packed**. We now turn to how these are represented at the byte and bit level, and how to implement the decoding and encoding.

## Bit-Level Details: Protobuf Wire Format and Encoding

Google Protocol Buffers uses a binary **TLV (Tag-Length-Value)** wire format. Each field in a message is encoded as a key (or tag) byte(s) followed by the data. The key is a combination of the field number and the wire type. 

- The **field number** is the ID from the .proto definition (e.g. 1 for id, 3 for vals, 8 for refs, etc.).
- The **wire type** is a 3-bit code indicating how the data is encoded (varint, 32-bit, 64-bit, length-delimited, etc.).

The key is stored as a *variant integer (varint)* that packs these together: **`key = (field_number << 3) | wire_type`** ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=The%20%E2%80%9Ctag%E2%80%9D%20of%20a%20record,tells%20us%20the%20field%20number)). In binary, the lowest 3 bits of the key are the wire type, and the remaining higher bits (shifted right by 3) give the field number ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=The%20%E2%80%9Ctag%E2%80%9D%20of%20a%20record,tells%20us%20the%20field%20number)). For example, a key byte of `0x0A` in hex is binary `0000 1010`. The low 3 bits `010` (which is 2) indicate wire type 2 (length-delimited), and the rest `00001` (which is 1 in decimal) indicate field number 1 ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=hex%20binary%20id%20value%20id,2)). Indeed 0x0A commonly appears as the tag for a length-delimited field 1 (many first fields are strings or sub-messages).

**Wire types of interest:** In Protobuf, the relevant wire type codes are ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=There%20are%20six%20wire%20types%3A,I32)):

- `0` – Varint: for integers (int32, int64, uint32/64, bool, enum, and also **sint32/sint64 after ZigZag transform**). These values are variable-length encoded using base-128 (7 bits per byte + 1 continuation bit).
- `1` – 64-bit: for fixed64, double (8 bytes little-endian). (OSM PBF does not use this type at all, since no 64-bit fixed fields or doubles in schema.)
- `2` – Length-delimited: for strings, byte blobs, embedded sub-messages, and **packed repeated fields**. A varint length N is given, then N bytes of data.
- `3` / `4` – Start and end of group (deprecated, not used in PBF).
- `5` – 32-bit: for fixed32, float (4 bytes). (Also not used in OSM PBF schema.)

In OSM PBF, **virtually all fields are either varints (wire type 0) or length-delimited (wire type 2)**. Coordinates, IDs, etc. are sint64 (varint). Strings and sub-messages are length-delimited. There are no fixed32/64 fields in the OSM schema, so wire types 1 and 5 do not occur for map data. This simplifies parsing: we mostly handle types 0 and 2.

**Varint encoding (base-128):** Varints allow efficient representation of small numbers while still being able to represent large ones. Each byte uses 7 bits for value and 1 bit as a continuation flag. If the MSB (most significant bit) of a byte is 1, it means more bytes follow; if 0, this byte is the last one in the varint ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=Each%20byte%20in%20the%20varint,payloads%20of%20its%20constituent%20bytes)) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=And%20here%20is%20150%2C%20encoded,is%20a%20bit%20more%20complicated)). The value bits from each byte are concatenated (in little-endian order: the first byte gives the lowest 7 bits, next byte gives the next 7 bits, etc.) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=Each%20byte%20in%20the%20varint,payloads%20of%20its%20constituent%20bytes)) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=as%20this%20is%20just%20there,bit%20integer)). Up to 10 bytes can be used for a 64-bit number (since 7*10 = 70 bits > 64, the extra bits must be zero).

For example, the number 150 (0x96 0x01 in varint) was shown in the Proto docs ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=And%20here%20is%20150%2C%20encoded,is%20a%20bit%20more%20complicated)) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=10010110%2000000001%20%20%20,bit%20integer)):
- 150 in binary is `10010110` (0x96) for the low 8 bits, and requires another bit beyond 7 bits.
- So it was split into two bytes: `10010110` and `00000001`. The first byte 0x96 has MSB=1 (meaning another byte follows) and lower 7 bits `0x16` (22 decimal). The second byte 0x01 has MSB=0 (last byte) and payload `0x01`.
- When decoding: remove MSBs -> combine payload bits -> reconstruct 150 ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=How%20do%20you%20figure%20out,bit%20integer)) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=10010110%2000000001%20%20%20,bit%20integer)).

In practice, as a parser, you read bytes until you encounter a byte with MSB 0, and accumulate the 7-bit chunks. For 64-bit values, you may read up to 10 bytes. For 32-bit, up to 5 bytes (though Protobuf doesn’t enforce a shorter cutoff for 32-bit fields, but values above 2^35 would be out of normal int32 range anyway).

**ZigZag encoding for signed ints (sint32/sint64):** Protobuf uses an encoding called ZigZag to efficiently encode negative numbers as varints ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=,between%20positive%20and%20negative%20numbers)). A signed integer is mapped to an unsigned varint in a way that small magnitude numbers (regardless of sign) get small varints. The formula is: 
```
zigzag(n) = (n << 1) ^ (n >> (bit_width - 1))
``` 
This effectively interleaves positive and negative numbers: 0 → 0, -1 → 1, 1 → 2, -2 → 3, 2 → 4, -3 → 5, etc. ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=,between%20positive%20and%20negative%20numbers)). In other words, positive p becomes 2*p, negative n becomes 2*|n| - 1. The result is then written as a varint. Decoding ZigZag is the inverse: `n = ((zigzag_value >>> 1) ^ -(zigzag_value & 1))`. 

All OSM “sint64” fields (node IDs, deltas, lat, lon, timestamp deltas, etc.) use ZigZag + varint. This means if you see a varint value like `0x91 0x02`, you should interpret it by first assembling the varint (say it comes out to 0x91 0x02 = 0x291 = 657 in decimal) and then decoding ZigZag: 657 in binary ends with 1, so it represents a negative number: -(657 & 1) XOR (657 >>> 1) = -1 XOR 328 = -329 or some such. It’s easier to implement this with the formula than do in head, but understanding that **odd varint results mean negative original, even mean positive** is helpful. For example, a ZigZag-encoded -1 yields 1, which as varint is just 0x01; a ZigZag-encoded +1 yields 2 (0x02 varint). So if we decode a varint and get 1, we know original was -1.

**Packed repeated fields:** When the .proto uses `[packed=true]` for a repeated primitive field, the wire format groups the entire list into a single key and length. Instead of writing each element with its own key, they write one occurrence of the field (with wire type 2), followed by a length N, then the back-to-back encoding of all the elements. All numeric types in OSM PBF that are repeated are indeed packed (see `[packed=true]` on keys, vals, refs, roles_sid, memids, etc. in the schema) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20Parallel%20arrays,packed%20%3D%20true)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=repeated%20uint32%20keys%20%3D%202,packed%20%3D%20true)) ([osmformat.proto - osmandapp/OsmAnd-resources - GitHub](https://github.com/osmandapp/OsmAnd-resources/blob/master/protos/osmformat.proto#:~:text=%2F%2F%20Special%20packing%20of%20keys,packed%20%3D%20true)). This means, for example, a way’s refs (field 8) will appear in the binary as: one tag byte for field8 (likely 0x42, since 8<<3|2 = 66 dec = 0x42) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Way%20,packed%20%3D%20true)), then a varint length, then that many bytes of varints (each representing a delta). The parser should read the length, then treat the following chunk as a sub-stream from which it repeatedly reads varints until it has consumed `length` bytes, thereby retrieving the entire array. The same applies to keys/vals arrays (packed as one blob of indices) and others. In the DenseNodes case, `id`, `lat`, `lon`, `keys_vals` are all packed and come each with one tag and length for the whole array ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=message%20DenseNodes%20,%2F%2F%20DELTA%20coded)).

**Example (from the Bremen example in OSM wiki):** They show part of the header parsing with actual bytes ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000000%20%20__%20__%20__,length%20120%20bytes)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=,z.E)). The BlobHeader “OSMHeader” was encoded as:
- `0d` 00 00 00 0d – (the length 13 in big-endian for BlobHeader) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000000%20%2000%2000%2000,V%202%20%27raw_size)).
- BlobHeader bytes: `0A 09 4F 53 4D 48 65 61 64 65 72 18 7C` which breaks down to:
  - `0A` → field1, wiretype2 (string) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=hex%20binary%20id%20value%20id,2)), 
  - `09` → length 9, 
  - `4F 53 4D 48 65 61 64 65 72` → "OSMHeader" in ASCII ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000000%20%20__%20__%20__,length%20120%20bytes)),
  - `18` → field3, wiretype0 (varint) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000000%20%20__%20__%20__,length%20120%20bytes)),
  - `7C` → value 124 (0x7C) for datasize ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000000%20%20__%20__%20__,length%20120%20bytes)).
- Then the Blob: first byte `10` → field2, wiretype0 (raw_size) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000010%20%207c%20,length%20120%20bytes)), next byte `71` (0x71) → value 113 for raw_size, then `1A` → field3, wiretype2 (zlib_data) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000010%20%20__%20__%2071,length%20120%20bytes)), next byte `78` (0x78) → length 120, followed by 120 bytes of compressed data (starting with `78 9C …`) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000010%20%20__%20__%20__,length%20120%20bytes)).

This illustrates the tag structure and varints: `0x7C` was a single-byte varint for 124, `0x71` for 113, etc. If the number was larger, we’d see multi-byte sequences.

For another example, a PrimitiveGroup with `OSMData` was shown where datasize was 87952, which encoded as three bytes `90 AF 05` (wiretype 0, field3) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000090%20%20__%20__%20__,length%2087944%20bytes)). Indeed, 0x05AF90 = 373,392 in decimal, but since it’s little-endian varint, we interpret `90 AF 05` as 0x05AF90 >> 1? Actually, let’s decode: bytes (in binary):
- 0x90 = 1001 0000 (MSB=1, payload 0x10),
- 0xAF = 1010 1111 (MSB=1, payload 0x2F),
- 0x05 = 0000 0101 (MSB=0, payload 0x05).
Concatenate payloads in little-endian order: 0x05 (highest bits) 0x2F 0x10 (lowest bits) = 0x052F10. That in decimal is 338704. Hmm, perhaps I need to double-check; possibly those bytes included also the tag for datasize (0x18) and then these 3 as the value. Actually, `18` (which is 0x18) was the tag for datasize field, and `90 AF 05` was the varint value ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000090%20%20__%20__%2007,length%2087944%20bytes)). 0x05AF90 = 372,624 decimal. It was labeled “87952 bytes long” in the wiki ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000090%20%20__%20__%20__,length%2087944%20bytes)) – likely I mis-read the order; it might be little-endian in assembly: 0x05 + (0xAF << 7) + (0x10 << 14)? In any case, multi-byte varints can represent those larger sizes.

The main point is that writing and reading these varints and tags correctly is crucial for parsing and serializing the PBF.

## Parsing OSM PBF in JavaScript

With the structural understanding above, we can outline how to implement a parser for OSM PBF in JavaScript. We will focus on using Node.js Buffer or browser ArrayBuffer/DataView for binary access, and we’ll use functional style with closures and arrow functions for clarity.

**High-level parse procedure:**

1. **Read the BlobHeader length (4 bytes)**: Use big-endian. In Node, one can do:
   ```js
   const buffer = fs.readFileSync('pitcairn-islands-latest.osm.pbf');
   let offset = 0;
   const blobHeaderSize = buffer.readUInt32BE(offset); 
   offset += 4;
   ```
   This gives the length of the upcoming BlobHeader message.
2. **Parse the BlobHeader message**: We need to read `blobHeaderSize` bytes and decode the BlobHeader fields (`type`, `datasize`, possibly `indexdata`). We can write a small decoder for this, since BlobHeader has a simple structure. For example:
   ```js
   const blobHeaderBytes = buffer.slice(offset, offset + blobHeaderSize);
   offset += blobHeaderSize;
   // We'll use a local offset pointer for blobHeaderBytes
   let o = 0;
   const readVarint = () => {
     let result = 0;
     let shift = 0;
     while (true) {
       const byte = blobHeaderBytes[o++];
       result |= (byte & 0x7F) << shift;
       if (!(byte & 0x80)) break;
       shift += 7;
     }
     return result;
   };
   const readString = (len) => {
     const strBytes = blobHeaderBytes.slice(o, o+len);
     o += len;
     return strBytes.toString('utf8');
   };
   // Now read fields
   let type = "", datasize = 0;
   // BlobHeader fields can come in any order, but typically: type (1), indexdata (2) maybe, datasize (3)
   while (o < blobHeaderBytes.length) {
     const keyByte = blobHeaderBytes[o++];
     const fieldNum = keyByte >> 3;
     const wireType = keyByte & 0x7;
     if (fieldNum === 1 && wireType === 2) { // string 'type'
       const len = readVarint();
       type = readString(len);
     } else if (fieldNum === 2 && wireType === 2) { // indexdata
       const len = readVarint();
       o += len; // skip indexdata bytes
     } else if (fieldNum === 3 && wireType === 0) { // varint 'datasize'
       datasize = readVarint();
     } else {
       throw new Error("Unknown BlobHeader field or wire type");
     }
   }
   ```
   After this, we have `type` (should be `"OSMHeader"` or `"OSMData"`) and `datasize` (the length of the Blob). For Pitcairn’s first block, we expect `type = "OSMHeader"`.
3. **Read the Blob**: We know the blob length (`datasize`). Read that many bytes:
   ```js
   const blobBytes = buffer.slice(offset, offset + datasize);
   offset += datasize;
   ```
   Then parse the Blob message:
   ```js
   let b = 0;
   const readBlobVarint = () => { /* similar loop on blobBytes */ };
   let rawData = null;
   let blobUncompressedSize = null;
   while (b < blobBytes.length) {
     const key = blobBytes[b++];
     const fieldNum = key >> 3;
     const wireType = key & 0x7;
     if (fieldNum === 1 && wireType === 2) { // raw data
       const len = readBlobVarint();
       rawData = blobBytes.slice(b, b+len);
       b += len;
     } else if (fieldNum === 2 && wireType === 0) { // raw_size
       blobUncompressedSize = readBlobVarint();
     } else if (fieldNum === 3 && wireType === 2) { // zlib_data
       const len = readBlobVarint();
       const compData = blobBytes.slice(b, b+len);
       b += len;
       // decompress using zlib
       rawData = require('zlib').inflateSync(compData);
     } else {
       // skip other compression types or unknown fields similarly
       if (wireType === 2) {
         const len = readBlobVarint();
         b += len;
       } else if (wireType === 0) {
         readBlobVarint();
       } else if (wireType === 5) {
         b += 4;
       } else if (wireType === 1) {
         b += 8;
       }
     }
   }
   ```
   After this, `rawData` is a Buffer containing the uncompressed bytes of the block content (either the HeaderBlock or a PrimitiveBlock). We can double-check that if `blobUncompressedSize` was provided, `rawData.length` equals it.

4. **Interpret the block content**:
   - **If `type === "OSMHeader"`**: We parse `rawData` according to the HeaderBlock structure. This is similar to how we parsed BlobHeader, but with more fields. We’d read keys until we exhaust the message. We look for field1 (bbox) which is a sub-message (wire type 2), field4/5 (required/optional features strings), field16 (writingprogram), 17 (source), 32/33/34 (replication info). Each string is prefixed by a varint length. Each repeated string field (like required_features) may appear multiple times; a robust parser should accumulate them into an array.
   
     For brevity, one might use an existing Protobuf library or a pre-compiled schema to parse HeaderBlock. But it’s doable manually:
     ```js
     const header = {};
     let p = 0;
     const readHeaderVarint = () => { ... };
     const readHeaderString = len => { ... };
     while (p < rawData.length) {
       const key = rawData[p++];
       const fieldNum = key >> 3;
       const wireType = key & 0x7;
       switch(fieldNum) {
         case 1: // bbox
           const bboxLen = readHeaderVarint();
           const bboxBytes = rawData.slice(p, p+bboxLen);
           p += bboxLen;
           // parse bbox message
           let bb = 0;
           const bbox = {};
           while (bb < bboxBytes.length) {
             const k = bboxBytes[bb++];
             const fn = k >> 3;
             const wt = k & 0x7;
             if (wt !== 0) throw Error("BBox fields are varints");
             const val = readHeaderVarint.call({ data: bboxBytes, pos: () => bb, ... });
             if (fn === 1) bbox.left = ZigZagDecode(val);
             if (fn === 2) bbox.right = ZigZagDecode(val);
             if (fn === 3) bbox.top = ZigZagDecode(val);
             if (fn === 4) bbox.bottom = ZigZagDecode(val);
           }
           header.bbox = bbox;
           break;
         case 4: // required_features
           const rfLen = readHeaderVarint();
           header.required_features = header.required_features || [];
           header.required_features.push( readHeaderString(rfLen) );
           break;
         case 5: // optional_features
           const ofLen = readHeaderVarint();
           header.optional_features = header.optional_features || [];
           header.optional_features.push( readHeaderString(ofLen) );
           break;
         case 16:
           const wpLen = readHeaderVarint();
           header.writingprogram = readHeaderString(wpLen);
           break;
         case 17:
           const srcLen = readHeaderVarint();
           header.source = readHeaderString(srcLen);
           break;
         case 32:
           header.replication_timestamp = readHeaderVarint();
           break;
         case 33:
           header.replication_seqno = readHeaderVarint();
           break;
         case 34:
           const urlLen = readHeaderVarint();
           header.replication_base_url = readHeaderString(urlLen);
           break;
         default:
           // skip unknown field
           if (wireType === 2) {
             const skipLen = readHeaderVarint();
             p += skipLen;
           } else if (wireType === 0) {
             readHeaderVarint();
           } else if (wireType === 5) {
             p += 4;
           } else if (wireType === 1) {
             p += 8;
           }
       }
     }
     ```
     This would fill a `header` object with the relevant fields. For Pitcairn, we’d get something like:
     ```js
     header = {
       bbox: { left: -12800000000, right: -12700000000, top: -2450000000, bottom: -2460000000 },
       required_features: ["OsmSchema-V0.6", "DenseNodes"],
       writingprogram: "osmium/1.5.1",
       source: "OpenStreetMap API 0.6",
       replication_timestamp: 1696521600,
       replication_seqno: 1234,
       replication_base_url: "http://download.geofabrik.de/australia-oceania/pitcairn-islands-updates"
     };
     ```
     (Values are illustrative).
     
     After parsing the header, the code would loop back to step 1 to read the next block (which should be OSMData).

   - **If `type === "OSMData"`**: We parse `rawData` as a PrimitiveBlock. This is more involved because of the nested structures and repeated fields. A straightforward strategy is:
     1. Parse the `StringTable` (field1). It’s an embedded message. We read its length, then read each string. In proto, `StringTable` has `repeated bytes s = 1`. That means inside that sub-message, every string is prefixed by the tag (field1, wire type 2) and a length. But since we know every entry uses the same field number (1), many implementations just read length after length until the sub-message bytes are consumed. We can do:
        ```js
        const block = {};
        let q = 0;
        // expecting field1 stringtable
        const stKey = rawData[q++];
        // should be 0x0A (field1, length-delimited)
        if ((stKey >> 3) !== 1 || (stKey & 0x7) !== 2) throw Error("Expected stringtable");
        const stLen = readBlockVarint();
        const stEnd = q + stLen;
        const stringTable = [];
        while (q < stEnd) {
          const skey = rawData[q++];
          if ((skey >> 3) !== 1) break; // no more strings
          const sLen = readBlockVarint();
          const str = rawData.slice(q, q+sLen).toString('utf8');
          q += sLen;
          stringTable.push(str);
        }
        block.stringTable = stringTable;
        // Note: index0 will be "", etc.
        ```
     2. Parse repeated PrimitiveGroup (field2). This will loop while there are bytes left in `rawData`:
        ```js
        block.entities = { nodes: [], ways: [], relations: [] };
        while (q < rawData.length) {
          const groupTag = rawData[q++];
          if ((groupTag >> 3) !== 2 || (groupTag & 0x7) !== 2) {
            throw Error("Expected PrimitiveGroup");
          }
          const groupLen = readBlockVarint();
          const groupBytes = rawData.slice(q, q+groupLen);
          q += groupLen;
          // Determine which field in PrimitiveGroup is set
          let r = 0;
          if (r >= groupBytes.length) continue;
          const firstFieldTag = groupBytes[r++];
          const fieldNum = firstFieldTag >> 3;
          const wType = firstFieldTag & 0x7;
          if (fieldNum === 1) {
            // Node(s) group (non-dense)
            // We'll skip since DenseNodes is expected
            // Would parse similarly to Way below, repeating Node messages
          } else if (fieldNum === 2) {
            // DenseNodes group
            if (wType !== 2) throw Error("DenseNodes should be length-delimited");
            const denseLen = (() => { // read varint from groupBytes starting at r })();
            const denseEnd = r + denseLen;
            // DenseNodes is a message with fields id=1, denseinfo=5, lat=8, lon=9, keys_vals=10
            const ids = [], lats = [], lons = [], keyVals = [];
            let denseInfo = null;
            // Initialize accumulators
            let prevId = 0, prevLat = 0, prevLon = 0;
            // parse fields in DenseNodes
            while (r < denseEnd) {
              const tagByte = groupBytes[r++];
              const fn = tagByte >> 3;
              const wt = tagByte & 0x7;
              if (fn === 1) { // id array
                const arrLen = (()=>{/*read varint*/})();
                const arrEnd = r + arrLen;
                let acc = 0n;
                while (r < arrEnd) {
                  const val = /* read ZigZag varint from groupBytes */;
                  // val is bigint or number
                  // Actually, since Node IDs <2^53, we could use Number safely here
                  acc += val;
                  ids.push(Number(acc));
                }
              } else if (fn === 5) { // denseinfo sub-message
                const diLen = (()=>{/*read varint*/})();
                // parse denseinfo similar to above: arrays version, timestamp, etc.
                // We could skip storing denseinfo in this example for simplicity
                denseInfo = {/*...*/};
                r += diLen;
              } else if (fn === 8) { // lat array
                const arrLen = (()=>{/*read varint*/})();
                const arrEnd = r + arrLen;
                let acc = 0n;
                while (r < arrEnd) {
                  const dz = /* ZigZag decode next varint */;
                  acc += dz;
                  lats.push(Number(acc));
                }
              } else if (fn === 9) { // lon array
                const arrLen = (()=>{/*read varint*/})();
                const arrEnd = r + arrLen;
                let acc = 0n;
                while (r < arrEnd) {
                  const dz = /* decode next varint */;
                  acc += dz;
                  lons.push(Number(acc));
                }
              } else if (fn === 10) { // keys_vals array
                const arrLen = (()=>{/*read varint*/})();
                const arrEnd = r + arrLen;
                while (r < arrEnd) {
                  keyVals.push(/* read next varint (uint32) */);
                }
              } else {
                // skip unexpected
                if (wt === 2) {
                  const skipLen = /*read varint*/;
                  r += skipLen;
                } else if (wt === 0) {
                  /*read varint*/;
                } else if (wt === 5) { r += 4; }
                else if (wt === 1) { r += 8; }
              }
            } // end while r < denseEnd
            // Now we have arrays ids[], lats[], lons[], keyVals[].
            // Use granularity and offsets from block (if any) to compute actual coords:
            const gran = block.granularity ?? 100;
            const lat_off = block.lat_offset ?? 0;
            const lon_off = block.lon_offset ?? 0;
            // keys_vals: we need to split into per-node tag lists.
            let kvIndex = 0;
            for (let i = 0; i < ids.length; i++) {
              const node = { id: ids[i], lat: 0, lon: 0, tags: {} };
              // compute lat/lon:
              node.lat = (lat_off + gran * lats[i]) * 1e-9;
              node.lon = (lon_off + gran * lons[i]) * 1e-9;
              // get tags from keyVals until a 0 delimiter
              if (keyVals.length > 0) {
                const tags = {};
                while (keyVals[kvIndex] !== 0) {
                  const keyIndex = keyVals[kvIndex++];
                  const valIndex = keyVals[kvIndex++];
                  tags[stringTable[keyIndex]] = stringTable[valIndex];
                }
                kvIndex++; // skip the 0
                node.tags = tags;
              }
              block.entities.nodes.push(node);
            }
          } else if (fieldNum === 3) {
            // Ways group (repeated Way messages)
            // We'll parse similarly: each way is a sub-message in groupBytes
            // The first byte we read for group told us fieldNum 3 and wType 2 (we'd see 0x1A typically).
            // Actually, since repeated ways share field number 3, each will start with 0x0A or 0x1A etc for its fields.
            r--; // step back one because we will parse multiple ways from this start
            while (r < groupBytes.length) {
              const wayTag = groupBytes[r++];
              if ((wayTag >> 3) !== 3) { 
                r--; break; // no more ways if we encounter another group field (like relations or changesets, but they wouldn't be in same group by spec).
              }
              if ((wayTag & 0x7) !== 2) throw Error("Way should be embedded message");
              const wayLen = /* read varint */;
              const wayEnd = r + wayLen;
              const way = { id:0, tags:{}, refs:[] };
              while (r < wayEnd) {
                const tagByte = groupBytes[r++];
                const fn = tagByte >> 3;
                const wt = tagByte & 0x7;
                if (fn === 1 && wt === 0) {
                  way.id = /* read varint (ID is non-delta int64) */;
                } else if (fn === 2 && wt === 2) {
                  const keysLen = /* read varint */;
                  const endPos = r + keysLen;
                  const keys = [];
                  while (r < endPos) { keys.push(/* read varint */); }
                  way._keys = keys; // store temporarily
                } else if (fn === 3 && wt === 2) {
                  const valsLen = /* read varint */;
                  const endPos = r + valsLen;
                  const vals = [];
                  while (r < endPos) { vals.push(/* read varint */); }
                  way._vals = vals;
                } else if (fn === 4 && wt === 2) {
                  const infoLen = /* read varint */;
                  r += infoLen; // (skip Info in this pseudo-code for brevity)
                } else if (fn === 8 && wt === 2) { // refs
                  const refsLen = /* read varint */;
                  const endPos = r + refsLen;
                  let accum = 0n;
                  while (r < endPos) {
                    const delta = /* read ZigZag varint */;
                    accum += delta;
                    way.refs.push(Number(accum));
                  }
                } else if ((fn === 9 || fn === 10) && wt === 2) {
                  // skip lat/lon if present (LocationsOnWays)
                  const skipLen = /* read varint */;
                  r += skipLen;
                } else {
                  // skip any other fields
                  if (wt === 0) { /* read varint to skip */; }
                  else if (wt === 2) { const skipLen = /* read varint */; r += skipLen; }
                  else if (wt === 5) { r += 4; }
                  else if (wt === 1) { r += 8; }
                }
              }
              // Now way is parsed, build tags from _keys and _vals
              if (way._keys && way._vals) {
                for (let j = 0; j < way._keys.length; j++) {
                  const kIdx = way._keys[j], vIdx = way._vals[j];
                  way.tags[stringTable[kIdx]] = stringTable[vIdx];
                }
              }
              delete way._keys; delete way._vals;
              block.entities.ways.push(way);
            }
          } else if (fieldNum === 4) {
            // Relations group (repeated Relation messages). Similar strategy to ways:
            r--;
            while (r < groupBytes.length) {
              const relTag = groupBytes[r++];
              if ((relTag >> 3) !== 4) { r--; break; }
              if ((relTag & 0x7) !== 2) throw Error("Relation should be embedded message");
              const relLen = /* read varint */;
              const relEnd = r + relLen;
              const rel = { id:0, tags:{}, members: [] };
              let roles = [], memids = [], types = [];
              while (r < relEnd) {
                const tagByte = groupBytes[r++];
                const fn = tagByte >> 3;
                const wt = tagByte & 0x7;
                if (fn === 1 && wt === 0) {
                  rel.id = /* read varint */;
                } else if (fn === 2 && wt === 2) {
                  const keysLen = /* read varint */; const endPos = r + keysLen;
                  const keys = []; while (r < endPos) keys.push(/* read varint */);
                  rel._keys = keys;
                } else if (fn === 3 && wt === 2) {
                  const valsLen = /* read varint */; const endPos = r + valsLen;
                  const vals = []; while (r < endPos) vals.push(/* read varint */);
                  rel._vals = vals;
                } else if (fn === 4 && wt === 2) {
                  const infoLen = /* read varint */; r += infoLen; // skip Info
                } else if (fn === 8 && wt === 2) { // roles_sid
                  const rolesLen = /* read varint */; const endPos = r + rolesLen;
                  while (r < endPos) roles.push(/* read varint */);
                } else if (fn === 9 && wt === 2) { // memids
                  const memLen = /* read varint */; const endPos = r + memLen;
                  let accum = 0n;
                  while (r < endPos) {
                    const delta = /* read ZigZag varint */;
                    accum += delta;
                    memids.push(Number(accum));
                  }
                } else if (fn === 10 && wt === 2) { // types
                  const typesLen = /* read varint */; const endPos = r + typesLen;
                  while (r < endPos) types.push(/* read varint */);
                } else {
                  // skip unknown
                  if (wt === 0) { /* skip varint */; }
                  else if (wt === 2) { const skipLen = /* read varint */; r += skipLen; }
                  else if (wt === 5) { r += 4; } else if (wt === 1) { r += 8; }
                }
              }
              // assign tags
              if (rel._keys && rel._vals) {
                rel._keys.forEach((kIdx, j) => {
                  const vIdx = rel._vals[j];
                  rel.tags[stringTable[kIdx]] = stringTable[vIdx];
                });
              }
              // assign members
              for (let m = 0; m < memids.length; m++) {
                const typeCode = types[m];  // 0=node,1=way,2=relation
                const member = { type: (typeCode===0?'node': typeCode===1?'way':'relation'),
                                 ref: memids[m],
                                 role: stringTable[roles[m]] };
                rel.members.push(member);
              }
              block.entities.relations.push(rel);
            }
          } else if (fieldNum === 5) {
            // changesets group, not expected here; skip similarly if encountered.
          }
        } // end of handling one PrimitiveGroup
        ```
        *The above pseudo-code is quite complex*, but outlines reading each structure. In implementation, one might break it into sub-functions for DenseNodes, Way, Relation for clarity, or use a streaming approach. For example, using a library like [`pbf` (by Mapbox)](https://github.com/mapbox/pbf) can simplify by defining how to read each field. Alternatively, one can compile the OSM `osmformat.proto` using `protobufjs` and then just call `Root.decode` to get objects. But doing it manually as above ensures we understand each byte.

After these steps, `block.entities` will hold arrays of node, way, relation objects with their IDs, coordinates (for nodes), tags, and member lists. We would then iterate to the next block if any (Pitcairn likely has just one OSMData block after the header, since all data fit in one).

**Verifying Pitcairn content:** After parsing, we might cross-check a few things:
- The number of nodes parsed should match the number of unique node IDs referenced by ways + any isolated nodes. If the relation’s members include a node, that node should be in the node list.
- The relation in Pitcairn should have 6 members as parsed, with roles exactly "outer" (4 times), "label", "admin_centre", matching what we know ([Relation: ‪Pitcairn Islands‬ (‪2185375‬) | OpenStreetMap](https://www.openstreetmap.org/relation/2185375#:~:text=6%20members)) ([Relation: ‪Pitcairn Islands‬ (‪2185375‬) | OpenStreetMap](https://www.openstreetmap.org/relation/2185375#:~:text=Way%20934644129%20as%20outer)).
- Coordinates of those member nodes (the label and admin_centre) can be looked up in the nodes list. We could verify, say, the admin_centre node has a `place=...` tag (likely `place=village` for Adamstown) and coordinates roughly near Pitcairn’s location.
- Tags: The ways that are outers should have `natural=coastline` or `boundary=administrative` etc., depending on mapping. The relation has `boundary=administrative`, `admin_level=2`, `name=Pitcairn Islands`, etc., which we should see in its tags.

This approach confirms the decode logic is correct.

#### Edge Cases:
- If a field or feature appears that we don’t handle (e.g. a unknown optional_feature, or a compression type like LZ4), a robust parser should skip/ignore unknown field types using the length or fixed sizes. The above pseudocode includes generic skipping logic for unknown wire types.
- 64-bit IDs: JavaScript Number can safely represent integers up to 2^53 (~9e15). OSM IDs currently are < 10^10, so fine. But if ever 64-bit values were used (like a hypothetical object ID > 9e15 or a changeset ID possibly?), one might need to keep them as BigInt. The code above uses BigInt for accumulation in a few places to be safe. NodeIDs and WayIDs likely safe as Number; RelationIDs too. Changeset IDs are around 9e7 now, user IDs <1e7.
- Large blocks: On a huge PBF (like planet), one would stream instead of readFileSync to handle memory. But Pitcairn is small, so reading wholly is fine.

## Writing OSM PBF in JavaScript

Writing (encoding) a PBF is the inverse of parsing: we need to construct bytes for BlobHeader and Blob and all nested fields. The general process:

1. Decide on block boundaries. For simplicity, we can put all nodes, ways, relations into one PrimitiveBlock (as Pitcairn does). If the data is huge, we’d chunk into multiple blocks, each with up to e.g. 8000 entities or staying under 16 MB uncompressed ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=All%20readers%20and%20writers%20must,and%20currently%20not%20widely%20used)).
2. Build the string table. Collect all unique strings from tags, user names, and relation roles. Ensure index 0 is reserved for `""`. One can do:
   ```js
   const stringSet = new Set([""]); // start with empty
   nodes.forEach(n => { for (let k in n.tags) { stringSet.add(k); stringSet.add(n.tags[k]); } });
   ways.forEach(w => { for (let k in w.tags) { stringSet.add(k); stringSet.add(w.tags[k]); } });
   relations.forEach(r => { for (let k in r.tags) { stringSet.add(k); stringSet.add(r.tags[k]); } 
                             r.members.forEach(m => stringSet.add(m.role)); });
   // also add usernames if writing user metadata:
   nodes.forEach(n => { if(n.user) stringSet.add(n.user); });
   // and similarly for ways, relations.
   const stringTable = [...stringSet];
   const stringIndex = Object.fromEntries(stringTable.map((str,i) => [str,i]));
   ```
   Now `stringTable[0] = ""`, etc., and we have a map for index lookups.
3. Construct the PrimitiveBlock message:
   - **StringTable**: Create bytes: For each string in `stringTable`, output tag `0x0A` (field1 wire2) then varint length then UTF-8 bytes. (Alternatively, many libraries will do this if given the StringTable structure).
   - **PrimitiveGroup(s)**:
     - **DenseNodes**: If we choose dense format for nodes (likely yes, if DenseNodes is in required_features), we need to sort nodes by ID (the spec doesn’t *require* sorting by ID, but typically they are in increasing ID order. However, Osmosis preserves original order which is usually sorted by type then by ID within type by design). To mimic the original, we might sort nodes by ID ascending. Then:
       * Compute delta arrays: `id_deltas = [id0, id1-id0, id2-id1, ...]`. ZigZag encode each delta.
       * Compute `lat` and `lon` arrays of scaled ints (calc int = round((lat/1e-7)) and same for lon, assuming granularity 100). Then delta encode those arrays similarly.
       * Build `keys_vals`: for each node in sequence, for each tag push [keyIndex, valIndex], then push 0 terminator. If a node has no tags, just push 0. (Omit keys_vals entirely if no node has tags).
       * If including DenseInfo: build parallel arrays for version (just use version numbers as-is), timestamp (seconds since epoch, then delta encode), changeset (delta encode), uid (delta encode), user_sid (map username to index and delta encode), visible (most will be true; if all true and HistoricalInformation not required, you could omit visible field).
       * Then produce the DenseNodes message:
         - field1 (id): packed varints of zigzag id deltas.
         - field5 (denseinfo): if present, an embedded DenseInfo message containing the packed arrays above.
         - field8 (lat): packed varints of zigzag lat deltas.
         - field9 (lon): packed varints of zigzag lon deltas.
         - field10 (keys_vals): packed uint32 of tag indices and 0s.
       * All of that is contained in one PrimitiveGroup (field2 of PrimitiveBlock).
     - **Ways**: For each way:
       * Sort ways by ID (if needed; original order in OSM XML is by ID after nodes).
       * Compute refs delta array for the node IDs of that way. ZigZag encode.
       * Prepare keys and vals index arrays for tags.
       * Build a Way message: field1 id (varint), field2 keys (packed), field3 vals (packed), field4 info (if including metadata, an Info submsg), field8 refs (packed sint64 deltas). (If “LocationsOnWays” were desired, include lat(9)/lon(10) with delta coords, but we’ll skip.)
       * The Way messages are grouped in one PrimitiveGroup (field3 of PrimitiveBlock). That means in bytes, we output one tag=0x1A per Way (since field3 wire2) followed by length and the content for that Way.
     - **Relations**: For each relation:
       * Sort by ID typically.
       * Compute memids delta array from member IDs (ZigZag).
       * Map member types to enum (0/1/2).
       * Map member roles to indices.
       * Prepare keys and vals for tags.
       * Build Relation message: field1 id, field2 keys (packed), field3 vals (packed), field4 info (opt), field8 roles_sid (packed uint32), field9 memids (packed sint64), field10 types (packed enum).
       * All Relation messages go in one PrimitiveGroup (field4 of PrimitiveBlock).
     - (No changesets for our case).
   - **PrimitiveBlock fields**: optionally include `granularity=100` (field17) if you want to be explicit (not strictly needed if using default), same for `date_granularity=1000` (field18). `lat_offset`/`lon_offset` only if using a non-zero (likely not). These would be small varints if included.
   - Concatenate: PrimitiveBlock = StringTable bytes + each PrimitiveGroup bytes + optional gran/date fields bytes.
4. Compress the PrimitiveBlock data (e.g. using zlib deflate).
5. Form the Blob message:
   - If compressed: include `raw_size` (uncompressed size), and `zlib_data` with compressed bytes.
   - If uncompressed: put data in `raw`.
   - Compute Blob serialized length.
6. Create BlobHeader:
   - Set `type = "OSMData"` and `datasize` = length of Blob.
   - Serialize BlobHeader (with the method similar to reading: output field1 (type) as 0x0A, length, string bytes; field3 (datasize) as 0x18, varint value).
   - Write 4-byte length of BlobHeader, then BlobHeader bytes, then Blob bytes to file/buffer.
7. Also create the HeaderBlock similarly:
   - Populate HeaderBlock fields (bbox if known, required_features including `"OsmSchema-V0.6"` and `"DenseNodes"`, writingprogram, etc., replication info if any).
   - Serialize to bytes.
   - Possibly compress it (Osmosis does compress even the header usually, but one could choose to store header uncompressed since it’s small).
   - Then wrap in Blob and BlobHeader with type "OSMHeader".

Due to the complexity, an easier route is to use an existing library. For example, using **protobuf.js**:
   - Load the `osmformat.proto` and `fileformat.proto` definitions,
   - Construct JS objects for HeaderBlock, PrimitiveBlock with proper nested arrays,
   - Use `Root.encode` to get a Uint8Array for each,
   - Then wrap with BlobHeader/Blob.

However, if doing manually in JS, one must be careful to produce exactly the correct varint encodings and field order. The order of fields doesn’t strictly matter (except that within packed fields, the values obviously have an order). But usually, writing fields in ascending field-number order is conventional.

**Example snippet (JavaScript) for ZigZag and varint encode**:
```js
const zigzagEncode64 = n => {
  // n can be a BigInt or Number
  // Convert to BigInt for uniformity
  let bn = BigInt(n);
  return bn >= 0n ? bn << 1n : (bn << 1n) ^ -1n;
};
const writeVarint = (num) => {
  // returns an array of bytes (Numbers 0-255) representing the varint
  let bn = BigInt(num);
  const bytes = [];
  while (bn >= 0x80n) {
    bytes.push(Number((bn & 0x7Fn) | 0x80n));
    bn >>= 7n;
  }
  bytes.push(Number(bn));  // last byte with MSB = 0
  return bytes;
};
// Example: encode sint64 value -13
let zz = zigzagEncode64(-13);        // = 25
let varintBytes = writeVarint(zz);   // = [25] since 25 < 128
console.log(varintBytes);           // [25]
```
For assembling the byte output, one can push bytes onto an array or use Node Buffer for performance. Ultimately, writing to a file or sending over network requires an ArrayBuffer or Buffer of the correct length.

**Constructing tags:** As discussed, the tag key for a field is `(fieldNum << 3 | wireType)`. For example, to write a string field number 17 (like `source` in HeaderBlock), wire type 2, we compute `(17<<3|2) = 136 | 2 = 138` which in hex is 0x8A, which matches what we saw in the example ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=00000040%20%2048%204f%2054,decompressed)). Our code can compute that or simply hardcode common ones.

**Writing packable fields:** If we have a list of numbers to write as packed, we:
   - Compute varint bytes for each element,
   - Compute total length = sum of those bytes lengths,
   - Write the field key (fieldNum with wiretype 2),
   - Write the length as varint,
   - Then write all the bytes sequentially.

E.g., writing a refs array [100, 110, 120] as sint64:
   - Deltas perhaps [100, 10, 10], ZigZag -> [200, 20, 20] (just an example if differences are 10 and 10 for simplicity),
   - Varint encode each: 200 -> [0xC8 0x01], 20 -> [0x14],
   - Combined length = 3 bytes.
   - Field8 tag = (8<<3|2) = 0x42 ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Way%20,packed%20%3D%20true)),
   - Length = 3 (varint [0x03]),
   - Data bytes [0xC8, 0x01, 0x14].
   - So we output: 0x42 0x03 0xC8 0x01 0x14.

**Final assembly:** We would produce a Buffer or Uint8Array for the entire file. It should start with the header block’s 4-byte length, etc. We must ensure to use network byte order for those 4-byte lengths (Buffer.writeUInt32BE).

Given the complexity, a fully coded example is beyond scope here, but the above outlines each step.

## Conclusion

The OpenStreetMap PBF format is intricate, but highly optimized. Each file is a sequence of blocks (BlobHeader + Blob). By interpreting the BlobHeader, we know what type of data follows and how to handle it (decompression, etc.). The core of the data is encoded via Protocol Buffers messages (HeaderBlock, PrimitiveBlock) using varint and zigzag encoding to minimize size. In the Pitcairn Islands example, we saw one OSMHeader block containing metadata (like required features `"OsmSchema-V0.6"` and `"DenseNodes"` ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=Currently%20the%20following%20features%20are,defined))), and one OSMData block containing a PrimitiveBlock with a string table and three PrimitiveGroups (dense nodes, ways, relations). We detailed how nodes are stored densely (deltas for IDs and coordinates) and how ways and relations use delta encoding for their member references. We also went through how to parse those bytes into meaningful objects using JavaScript, including dealing with the bit-level varint format ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=Each%20byte%20in%20the%20varint,payloads%20of%20its%20constituent%20bytes)) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=The%20%E2%80%9Ctag%E2%80%9D%20of%20a%20record,tells%20us%20the%20field%20number)) and zigzag transformation ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=,between%20positive%20and%20negative%20numbers)). Finally, we discussed composing or writing such a file by reversing the process – building the data structures and encoding field-by-field with proper wire types and packed formats.

By following this guide, one can write a parser to fully decode an OSM PBF file (like the Pitcairn extract) down to every node, way, and relation, as well as create or modify PBF files by constructing the appropriate byte sequences. The key is careful handling of the low-level details: 7-bit varints, ZigZag encoding for signed values, and ordering of bytes – all of which we have covered in detail. 

**Sources:**

- OpenStreetMap Wiki – *PBF Format* (specification of file structure, data model, and examples) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=,is%20given%20in%20the%20header)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20Blob%20,When%20compressed%2C%20the%20uncompressed%20size)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=%2F%2F%20Granularity%2C%20units%20of%20nanodegrees%2C,default%3D100)) ([PBF Format - OpenStreetMap Wiki](https://wiki.openstreetmap.org/wiki/PBF_Format#:~:text=message%20DenseNodes%20,%2F%2F%20DELTA%20coded))  
- Protocol Buffers – *Wire Format Encoding* (varint, ZigZag, and field key structure) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=Each%20byte%20in%20the%20varint,payloads%20of%20its%20constituent%20bytes)) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=The%20%E2%80%9Ctag%E2%80%9D%20of%20a%20record,tells%20us%20the%20field%20number)) ([Encoding | Protocol Buffers Documentation](https://protobuf.dev/programming-guides/encoding/#:~:text=,between%20positive%20and%20negative%20numbers))  
- Mapbox osmpbf-tutorial (illustrative breakdown of PBF bytes, used for confirmation of concepts) ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=message%20DenseNodes%20,%2F%2F%20DELTA%20coded)) ([GitHub - mapbox/osmpbf-tutorial](https://github.com/mapbox/osmpbf-tutorial#:~:text=match%20at%20L989%20See%20that,is%20called%20a%20packed%20field))  
- Pitcairn OSM data on OpenStreetMap (for verifying actual content like relation members and tags) ([Relation: ‪Pitcairn Islands‬ (‪2185375‬) | OpenStreetMap](https://www.openstreetmap.org/relation/2185375#:~:text=))