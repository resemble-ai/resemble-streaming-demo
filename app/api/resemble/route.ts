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
      // need to catch any error here as otherwise we will get- Error: failed to pipe response
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (error instanceof Error) {
          // TODO: at this point we should let the client know that something went wrong
          console.log(error.message);
        }
        controller.close();
      }
    },
  });
}

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
      if (isFirstChunk) {
        const endResemble = performance.now();
        const timeToFirstSound = endResemble - startResemble;
        console.log(
          `Time to first sound for Resemble: ${timeToFirstSound.toFixed(2)}ms`
        );
        isFirstChunk = false;

        // Create a fixed-size buffer for the metadata: time to first sound of 8 bytes.
        // the client will then parse this metadata, then the header and finally the audio data:

        // In JavaScript, a number is represented as a double-precision 64-bit binary format IEEE 754 value (a "double").

        // In the context of timing data, such as "time to first sound" measurement, 8 bytes for a floating-point
        // number provide extremely high precision and a vast range that is more than sufficient for our use case😄

        const metadataBuffer = new ArrayBuffer(8);
        const metadataView = new DataView(metadataBuffer);
        // Store the timeToFirstSound in the first 8 bytes (as a float64)
        metadataView.setFloat64(0, timeToFirstSound, true);
        yield new Uint8Array(metadataBuffer);
      }
      yield chunk;
    }
  }
}

export async function POST(request: Request) {
  const req = await request.json();
  const query = req.query;

  const iterator = audioChunkGenerator(query);
  const stream = iteratorToStream(iterator);

  const headers = new Headers();
  headers.set("Content-Type", "audio/wav");

  const response = new Response(stream, { headers });
  return response;
}
