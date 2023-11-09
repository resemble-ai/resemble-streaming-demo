import { Resemble } from "@resemble/node";

const RESEMBLE_ENDPOINT = process.env.RESEMBLE_ENDPOINT;
const RESEMBLE_TOKEN = process.env.RESEMBLE_TOKEN;
const RESEMBLE_PROJECT_ID = process.env.RESEMBLE_PROJECT_ID;
const RESEMBLE_VOICE_ID = process.env.RESEMBLE_VOICE_ID;

if (
  !RESEMBLE_ENDPOINT ||
  !RESEMBLE_TOKEN ||
  !RESEMBLE_PROJECT_ID ||
  !RESEMBLE_VOICE_ID
) {
  throw new Error("Missing environment variables");
}

const MIN_CHUNK_SIZE = 4096 * 12; // Adjust as needed
Resemble.setApiKey(RESEMBLE_TOKEN);
Resemble.setSynthesisUrl(RESEMBLE_ENDPOINT);

function iteratorToStream(iterator: AsyncGenerator<Uint8Array, void, unknown>) {
  return new ReadableStream({
    async pull(controller) {
      // need to catch any error here as otherwise we will get a Error: failed to pipe response from Next
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (error instanceof Error) {
          // Crude error handling: client can show an error UI based on the error message
          controller.enqueue("Error: " + error.message);
        }
        controller.close();
      }
    },
  });
}

let buffer = new Uint8Array(0);
async function* audioChunkGenerator(text: string) {
  let startResemble = performance.now();
  let isFirstChunk = true;
  for await (const out of Resemble.v2.clips.stream(
    {
      data: text,
      sample_rate: 22050,
      precision: "PCM_16",
      project_uuid: RESEMBLE_PROJECT_ID!,
      voice_uuid: RESEMBLE_VOICE_ID!,
    },
    {
      bufferSize: MIN_CHUNK_SIZE,
      ignoreWavHeader: false,
    }
  )) {
    const { data: chunk } = out as { data: Uint8Array };

    if (chunk) {
      // Add chunk to buffer
      const newBuffer = new Uint8Array(buffer.byteLength + chunk.byteLength);
      newBuffer.set(buffer);
      newBuffer.set(chunk, buffer.byteLength);
      buffer = newBuffer;

      // Only yield if we have enough data or if byte length is even
      if (
        buffer.byteLength >= MIN_CHUNK_SIZE || // TODO
        buffer.byteLength % 2 === 0
      ) {
        yield buffer;
        buffer = new Uint8Array(0); // Reset buffer
      }

      if (isFirstChunk) {
        const endResemble = performance.now();
        const timeToFirstSound = endResemble - startResemble;
        console.log(
          `Time to first sound for Resemble: ${timeToFirstSound.toFixed(2)}ms`
        );
        isFirstChunk = false;
      }
    }
  }

  // Yield any remaining data in the buffer when stream ends
  if (buffer.byteLength > 0) {
    yield buffer;
  }
}

export async function POST(request: Request) {
  const req = await request.json();
  const query = req.query;

  let iterator;
  let stream;

  iterator = audioChunkGenerator(query);
  stream = iteratorToStream(iterator);

  // Set up the response with audio/wav content type
  const headers = new Headers();
  headers.set("Content-Type", "audio/wav");

  const response = new Response(stream, { headers });
  return response;
}
