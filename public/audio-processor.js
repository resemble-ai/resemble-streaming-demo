class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioQueue = [];
    this.isProcessingAllowed = true;
    console.log("AudioWorkletProcessor constructor: INITIALIZED");

    this.port.onmessage = (event) => {
      // https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode/port#examples
      try {
        if (event.data.type === "audio-end") {
          this.isEndofChunks = true;
        }
        if (event.data.type === "stop-processor") {
          this.isProcessingAllowed = false;
          this.audioQueue = []; // Clear the queue to start fresh
        }
        if (event.data.type === "reset-processor") {
          this.isProcessingAllowed = true;
          this.audioQueue = []; // Clear the queue to start fresh
        }
        if (event.data.type === "audio-chunk") {
          // Ensure chunk is an array before spreading
          if (Array.isArray(event.data.chunk)) {
            this.audioQueue.push(...event.data.chunk);
          } else {
            this.audioQueue.push(event.data.chunk);
          }
        }
      } catch (error) {
        console.error("Error in AudioProcessor.port.onmessage:", error);
      }
    };
  }

  process(inputs, outputs, parameters) {
    if (!this.isProcessingAllowed) {
      return false;
    }
    try {
      const output = outputs[0];
      const outputChannel = output[0];
      const audioQueueLength = this.audioQueue.length;

      if (this.isEndofChunks && !audioQueueLength) {
        console.log("AudioWorkletProcessor process: STOPPED");
        return false; // Stops the processor
      }

      if (audioQueueLength) {
        const chunk = this.audioQueue.shift(); // Remove the first element from the queue
        outputChannel.set(chunk);
      } else {
        // Fill the output buffer with silence when there's no data
        console.log("AudioWorkletProcessor process: silence");
        outputChannel.fill(0);
      }

      return true; // Keep the processor alive
    } catch (error) {
      console.error("Error in AudioWorkletProcessor process:", error);
      return false;
    }
  }
}

registerProcessor("audio-processor", AudioProcessor);
