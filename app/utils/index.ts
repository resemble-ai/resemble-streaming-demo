export function int16ArrayToFloat32Array(int16Array: Int16Array) {
  let l = int16Array.length;
  let float32Array = new Float32Array(l);
  for (let i = 0; i < l; i++) {
    let normalized =
      int16Array[i] < 0 ? int16Array[i] / 32768 : int16Array[i] / 32767;
    float32Array[i] = normalized;
  }
  return float32Array;
}
