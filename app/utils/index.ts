export function int16ArrayToFloat32Array(int16Array: Int16Array) {
  let l = int16Array.length;
  let float32Array = new Float32Array(l);
  for (let i = 0; i < l; i++) {
    let normalized = int16Array[i] / 32768.0;
    float32Array[i] = Math.max(-1, Math.min(1, normalized));
  }
  return float32Array;
}

export function mergeUint8Arrays(chunks: Uint8Array[]) {
  // Calculate the total length of all chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);

  // Create a new array with total length
  const mergedArray = new Uint8Array(totalLength);
  console.log("mergedArray length", mergedArray.length);

  // Copy each chunk into the merged array
  let offset = 0;
  for (const chunk of chunks) {
    mergedArray.set(chunk, offset);
    offset += chunk.length;
  }

  console.log(mergedArray.length);
  return mergedArray;
}

// The duration of the silence introduced by a single zero padding (if required) depends on the sample rate of the audio data.
// Silence Duration (seconds) = 1 / Sample Rate
// so the duration of silence introduced by a single zero padding is approximately 1 / 44,100 seconds, which is roughly 22.7 microseconds for 44.1 kHz audio data: hardly perceptible to the human ear
export function padAudioData(arrayBuffer: ArrayBuffer): Int16Array {
  const uint8Array = new Uint8Array(arrayBuffer);

  // Calculate the number of missing bytes to make it a multiple of 2
  const missingBytes = uint8Array.length % 2 === 1 ? 1 : 0;

  // Create a new Uint8Array with the padded length
  const paddedData = new Uint8Array(uint8Array.length + missingBytes);

  // Copy the original data into the padded array
  paddedData.set(uint8Array);

  // Create an Int16Array from the padded Uint8Array
  const int16Array = new Int16Array(paddedData.buffer);

  return int16Array;
}

export function inspectLast10ValuesInChunks(int16Array: Int16Array) {
  let chunkSize = 10; // Define the size of the chunk to inspect (in this case, 10 values)
  let l = int16Array.length;
  let numberOfChunks = Math.ceil(l / chunkSize);

  for (let i = 0; i < numberOfChunks; i++) {
    // Calculate the start and end indices for the current chunk
    let start = i * chunkSize;
    let end = Math.min(start + chunkSize, l);

    // Extract the last 10 values from the current chunk
    let last10Values = new Int16Array(int16Array.slice(end - chunkSize, end));

    // Log the last 10 values for the current chunk
    console.log(`Chunk ${i + 1} - Last 10 values:`, last10Values);
  }
}
