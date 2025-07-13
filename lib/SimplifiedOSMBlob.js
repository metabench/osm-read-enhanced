/**
 * Optimized OSM_Blob implementation
 * Removes decode mode complexity for maximum performance
 */

class SimplifiedOSMBlob {
  constructor(stringTable, dataView, dataOffset, dataSize, options = {}) {
    this.stringTable = stringTable;
    this.dataView = dataView;
    this.dataOffset = dataOffset;
    this.dataSize = dataSize;
    this._index = options.index || 0;
    
    // Pre-build string lookup for performance
    this.strings = [];
    if (stringTable && stringTable.s) {
      for (let i = 0; i < stringTable.s.length; i++) {
        this.strings[i] = stringTable.s[i].toString('utf8');
      }
    }
  }

  fastParse(eventEmitter) {
    const start = process.hrtime.bigint();
    
    const data = Buffer.from(this.dataView.buffer, this.dataView.byteOffset + this.dataOffset, this.dataSize);
    let offset = 0;
    
    let nodeCount = 0;
    let wayCount = 0;
    let relationCount = 0;
    
    // Parse primitive groups - simplified without decode mode checks
    while (offset < data.length) {
      try {
        const keyInfo = this._readVarint(data, offset);
        const key = keyInfo.value;
        offset += keyInfo.bytesRead;
        
        const fieldNumber = key >> 3;
        const wireType = key & 0x07;
        
        if (wireType === 2) { // Length-delimited
          const lenInfo = this._readVarint(data, offset);
          offset += lenInfo.bytesRead;
          
          const fieldData = data.slice(offset, offset + lenInfo.value);
          
          if (fieldNumber === 2) { // DenseNodes
            const parsed = this._fastParseDenseNodes(fieldData, eventEmitter);
            nodeCount += parsed;
          } else if (fieldNumber === 3) { // Ways
            this._fastParseWay(fieldData, eventEmitter);
            wayCount++;
          } else if (fieldNumber === 4) { // Relations
            this._fastParseRelation(fieldData, eventEmitter);
            relationCount++;
          }
          
          offset += lenInfo.value;
        } else {
          offset = this._skipField(data, offset, wireType);
        }
      } catch (e) {
        break;
      }
    }
    
    const end = process.hrtime.bigint();
    const time = Number(end - start) / 1000000;
    
    return { 
      nodes: nodeCount, 
      ways: wayCount, 
      relations: relationCount,
      time: time
    };
  }
  
  _fastParseDenseNodes(data, eventEmitter) {
    let offset = 0;
    let nodeCount = 0;
    
    // Find and parse the ID field to count nodes
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 2) { // id field (packed)
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        
        const endOffset = offset + lenInfo.value;
        let id = 0;
        
        // Count and emit nodes
        while (offset < endOffset) {
          const deltaInfo = this._readSignedVarint(data, offset);
          offset += deltaInfo.bytesRead;
          id += deltaInfo.value;
          
          if (eventEmitter) {
            eventEmitter.emit('node', { id: id });
          }
          nodeCount++;
        }
        
        return nodeCount;
      } else {
        offset = this._skipField(data, offset - keyInfo.bytesRead, wireType);
      }
    }
    
    return nodeCount;
  }
  
  _fastParseWay(data, eventEmitter) {
    let offset = 0;
    let id = 0;
    let refs = [];
    let tags = {};
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 0) { // id
        const idInfo = this._readVarint(data, offset);
        id = idInfo.value;
        offset += idInfo.bytesRead;
      } else if (fieldNumber === 2 && wireType === 0) { // keys
        const keyInfo = this._readVarint(data, offset);
        offset += keyInfo.bytesRead;
        
        const valKeyInfo = this._readVarint(data, offset);
        const valKey = valKeyInfo.value;
        offset += valKeyInfo.bytesRead;
        
        if (valKey >> 3 === 3) { // vals
          const valInfo = this._readVarint(data, offset);
          offset += valInfo.bytesRead;
          
          const keyStr = this.strings[keyInfo.value] || `key_${keyInfo.value}`;
          const valStr = this.strings[valInfo.value] || `val_${valInfo.value}`;
          tags[keyStr] = valStr;
        }
      } else if (fieldNumber === 8 && wireType === 2) { // refs (packed)
        const lenInfo = this._readVarint(data, offset);
        offset += lenInfo.bytesRead;
        
        const endOffset = offset + lenInfo.value;
        let ref = 0;
        
        while (offset < endOffset) {
          const deltaInfo = this._readSignedVarint(data, offset);
          offset += deltaInfo.bytesRead;
          ref += deltaInfo.value;
          refs.push(ref);
        }
      } else {
        offset = this._skipField(data, offset - keyInfo.bytesRead, wireType);
      }
    }
    
    if (eventEmitter) {
      eventEmitter.emit('way', { id, refs, tags });
    }
  }
  
  _fastParseRelation(data, eventEmitter) {
    let offset = 0;
    let id = 0;
    let members = [];
    let tags = {};
    
    while (offset < data.length) {
      const keyInfo = this._readVarint(data, offset);
      const key = keyInfo.value;
      offset += keyInfo.bytesRead;
      
      const fieldNumber = key >> 3;
      const wireType = key & 0x07;
      
      if (fieldNumber === 1 && wireType === 0) { // id
        const idInfo = this._readVarint(data, offset);
        id = idInfo.value;
        offset += idInfo.bytesRead;
      } else if (fieldNumber === 2 && wireType === 0) { // keys
        const keyInfo = this._readVarint(data, offset);
        offset += keyInfo.bytesRead;
        
        const valKeyInfo = this._readVarint(data, offset);
        const valKey = valKeyInfo.value;
        offset += valKeyInfo.bytesRead;
        
        if (valKey >> 3 === 3) { // vals
          const valInfo = this._readVarint(data, offset);
          offset += valInfo.bytesRead;
          
          const keyStr = this.strings[keyInfo.value] || `key_${keyInfo.value}`;
          const valStr = this.strings[valInfo.value] || `val_${valInfo.value}`;
          tags[keyStr] = valStr;
        }
      } else {
        offset = this._skipField(data, offset - keyInfo.bytesRead, wireType);
      }
    }
    
    if (eventEmitter) {
      eventEmitter.emit('relation', { id, members, tags });
    }
  }
  
  // Fast varint reading (optimized)
  _readVarint(data, offset) {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    
    // Fast path for single byte (most common)
    if (offset < data.length && data[offset] < 0x80) {
      return { value: data[offset], bytesRead: 1 };
    }
    
    // Full varint reading
    while (offset + bytesRead < data.length && bytesRead < 10) {
      const byte = data[offset + bytesRead];
      value |= (byte & 0x7F) << shift;
      bytesRead++;
      
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }
    
    return { value, bytesRead };
  }
  
  _readSignedVarint(data, offset) {
    const info = this._readVarint(data, offset);
    const value = (info.value >>> 1) ^ (-(info.value & 1));
    return { value, bytesRead: info.bytesRead };
  }
  
  _skipField(data, offset, wireType) {
    const key = data[offset++];
    
    switch (wireType) {
      case 0: // Varint
        while (offset < data.length && (data[offset] & 0x80) !== 0) {
          offset++;
        }
        return offset + 1;
      case 2: // Length-delimited
        const lenInfo = this._readVarint(data, offset);
        return offset + lenInfo.bytesRead + lenInfo.value;
      default:
        return offset + 1;
    }
  }
}

module.exports = SimplifiedOSMBlob;
