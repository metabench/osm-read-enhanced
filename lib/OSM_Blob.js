/*
OSM_Blob class:
• Accepts a spec object with:
    - index: the integer index of the blob.
    - data: the decompressed blob data (Buffer or Uint8Array).
• Exposes a .buffer property for the raw data.
• Implements its own PBF decoding (without external modules) to extract the stringtable.
• Provides an iterate_stringtable() method that returns an iterable over the UTF-8 strings in the stringtable.
*/
class OSM_Blob {
  constructor(spec = {}) {
    if (spec.index === undefined) {
      throw new Error("Missing required 'index' property");
    }
    if (spec.data === undefined) {
      throw new Error("Missing required 'data' property");
    }
    this._index = spec.index;
    // Always store data as a Buffer.
    this._buffer = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data);
    // Cache for the stringtable slice information (start and end within _buffer).
    this._stringtableSlice = null;
  }

  // Returns the blob's index.
  get index() {
    return this._index;
  }

  // Returns the raw blob data.
  get buffer() {
    return this._buffer;
  }

  // Internal helper to read a varint from buffer starting at offset.
  // Returns an object { value, bytesRead }.
  _readVarint(buffer, offset) {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;
    while (true) {
      if (offset >= buffer.length) {
        throw new Error("Buffer ended while reading varint");
      }
      const byte = buffer[offset++];
      bytesRead++;
      result |= (byte & 0x7F) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    return { value: result, bytesRead };
  }

  // Internal helper to skip an unknown field given its wire type.
  // Returns the new offset.
  _skipField(buffer, offset, wireType) {
    switch (wireType) {
      case 0: { // Varint
        const varint = this._readVarint(buffer, offset);
        return offset + varint.bytesRead;
      }
      case 1: { // 64-bit
        return offset + 8;
      }
      case 2: { // Length-delimited
        const lenVar = this._readVarint(buffer, offset);
        return offset + lenVar.bytesRead + lenVar.value;
      }
      case 5: { // 32-bit
        return offset + 4;
      }
      default:
        throw new Error(`Unsupported wire type: ${wireType}`);
    }
  }

  // Internal method to locate the stringtable slice inside the decompressed blob.
  // Assumes that the PrimitiveBlock message has field number 1 (wire type 2)
  // that contains the stringtable message.
  _findStringTableSlice() {
    const buffer = this._buffer;
    let offset = 0;
    while (offset < buffer.length) {
      const keyInfo = this._readVarint(buffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      if (fieldNumber === 1 && wireType === 2) { // stringtable field
        const lenInfo = this._readVarint(buffer, offset);
        offset += lenInfo.bytesRead;
        const start = offset;
        const end = offset + lenInfo.value;
        return { start, end };
      } else {
        offset = this._skipField(buffer, offset, wireType);
      }
    }
    return null;
  }

  // Internal generator function to lazily decode the stringtable.
  // Iterates over the raw bytes inside the stringtable and yields decoded strings.
  *_iterateStringTable() {
    if (!this._stringtableSlice) {
      this._stringtableSlice = this._findStringTableSlice();
    }
    if (!this._stringtableSlice) {
      return; // No stringtable found.
    }
    const stBuffer = this._buffer.slice(this._stringtableSlice.start, this._stringtableSlice.end);
    let offset = 0;
    while (offset < stBuffer.length) {
      const keyInfo = this._readVarint(stBuffer, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      if (fieldNumber === 1 && wireType === 2) { // Each string is in field 1
        const lenInfo = this._readVarint(stBuffer, offset);
        offset += lenInfo.bytesRead;
        const strBytes = stBuffer.slice(offset, offset + lenInfo.value);
        offset += lenInfo.value;
        yield strBytes.toString('utf8');
      } else {
        offset = this._skipField(stBuffer, offset, wireType);
      }
    }
  }

  // Public method: returns an iterable over the strings in the stringtable.
  // Decoding occurs lazily as the iterator is consumed.
  iterate_stringtable() {
    return {
      [Symbol.iterator]: () => this._iterateStringTable()
    };
  }
}

module.exports = OSM_Blob;
