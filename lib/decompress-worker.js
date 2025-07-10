const { parentPort } = require('worker_threads');
const zlib = require('zlib');

parentPort.on('message', (task) => {
  const { idx, data, input_chunk_index, event } = task;
  const buffer = Buffer.from(data);
  
  // Select decompression function concisely
  const decompressFn = (buffer[0] === 0x78)
    ? zlib.inflate
    : (buffer[0] === 0x1F && buffer[1] === 0x8B)
      ? zlib.gunzip
      : zlib.inflateRaw;
  
  decompressFn(buffer, (err, result) => {
    if (err) {
      parentPort.postMessage({ idx, error: err.message });
    } else {
      parentPort.postMessage({ idx, result, input_chunk_index, globalOffset: event.globalOffset });
    }
  });
});
