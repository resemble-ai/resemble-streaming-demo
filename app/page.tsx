/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, FormEvent, useRef, useEffect } from "react";
import { int16ArrayToFloat32Array, mergeUint8Arrays } from "./utils";
import {
  Badge,
  Button,
  Container,
  Flex,
  Text,
  TextArea,
  Tooltip,
  Card,
} from "@radix-ui/themes";
import {
  Cross1Icon,
  InfoCircledIcon,
  PlayIcon,
  ReloadIcon,
  StopIcon,
} from "@radix-ui/react-icons";

import Swal from "sweetalert2";

const BUFFER_SIZE = 128;
const WAV_HEADER_SIZE = 44;
const MAX_TEXT_LENGTH = 2000;

let isAudioWorkletModuleAdded = false;
export default function Home() {
  const [state, setState] = useState<
    "ready" | "streaming" | "playing" | "error"
  >("ready");
  const [text, setText] = useState("");
  const [ttfs, setTtfs] = useState(0);
  const [networkTime, setNetworkTime] = useState(0);

  const hasSkippedHeaderRef = useRef(false);
  const hasReadMetadataRef = useRef(false);
  const scriptNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const stopRequestedRef = useRef(false);
  const streamBufferRef = useRef<Uint8Array[]>([]);
  const streamEndedRef = useRef(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | undefined>(
    undefined
  );

  useEffect(() => {
    // Cleanup function to handle component unmount
    return () => {
      if (readerRef.current) {
        readerRef.current.cancel(); // Cancel the stream reading when unmounting
      }
    };
  }, []);

  const kickOffBufferredPlayback = () => {
    console.log("kick off bufferred playback");
    if (streamEndedRef.current && streamBufferRef.current.length === 0) {
      if (scriptNodeRef.current && scriptNodeRef.current.port) {
        scriptNodeRef.current.port.postMessage({ type: "audio-end" });
      }
      return;
    }

    while (streamBufferRef.current.length > 0) {
      let buffer = streamBufferRef.current.shift();

      // Merge chunks until we have an even length buffer
      if (buffer) {
        while (buffer.length % 2 === 1 && streamBufferRef.current.length > 0) {
          const nextBuffer = streamBufferRef.current.shift();
          if (nextBuffer) {
            console.log(
              "Merging odd length buffer of size",
              buffer.length,
              "with next buffer of size",
              nextBuffer.length
            );
            buffer = mergeUint8Arrays([buffer, nextBuffer]);
          }
        }

        if (buffer.length % 2 === 1) {
          // If the buffer is still of odd length and there are no more chunks to merge, put it back and break the loop
          console.log(
            "Odd length buffer remains, putting it back:",
            buffer.length
          );
          streamBufferRef.current.unshift(buffer);
          break;
        }
      }

      if (buffer && buffer.length > 0) {
        console.log("Processing buffer of even length", buffer.length);

        const audioData = int16ArrayToFloat32Array(
          new Int16Array(buffer.buffer)
        );
        let startIdx = 0;

        while (startIdx < audioData.length) {
          const chunkSize = Math.min(audioData.length - startIdx, BUFFER_SIZE);
          const chunk = audioData.slice(startIdx, startIdx + chunkSize);

          startIdx += chunkSize;

          if (state !== "playing") {
            setState("playing");
          }
          if (scriptNodeRef.current && !stopRequestedRef.current) {
            scriptNodeRef.current.port.postMessage({
              type: "audio-chunk",
              chunk,
            });
          }
        }
      }
    }
  };

  const errorHandler = (error: Error) => {
    console.log("Error reading audio stream:", error);
    Swal.fire({
      title: "Error!",
      text: "Something went wrong. Please try again.",
      icon: "error",
    });
  };

  const handleSynthesis = async (text: string) => {
    // reset everything
    if (scriptNodeRef.current && scriptNodeRef.current.port) {
      scriptNodeRef.current.port.postMessage({ type: "reset-processor" });
    }
    stopRequestedRef.current = false;
    hasSkippedHeaderRef.current = false;
    hasReadMetadataRef.current = false;
    streamBufferRef.current = [];

    const startTime = performance.now();

    try {
      setState("streaming");
      const res = await fetch("/api/resemble", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        cache: "no-store", // TODO: check if this is needed
        body: JSON.stringify({ query: text }),
      });
      const reader = res.body?.getReader();

      if (reader) {
        readerRef.current = reader;
        let totalstreamlength = 0;
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            streamEndedRef.current = true;
            break;
          }
          if (value && value.length > 0) {
            let chunk = value;
            // skip metadata and wav header if required
            if (!hasReadMetadataRef.current) {
              const metadataView = new DataView(value.buffer, 0, 8); // Adjust size if needed (i.e if you added more metadata to the response)
              const timeToFirstSound = metadataView.getFloat64(0, true);
              setTtfs(Math.round(timeToFirstSound));
              setNetworkTime(Math.round(performance.now() - startTime));

              hasReadMetadataRef.current = true;
              chunk = chunk.slice(8);
            }

            // skip wav header
            if (!hasSkippedHeaderRef.current) {
              chunk = chunk.slice(WAV_HEADER_SIZE);
              hasSkippedHeaderRef.current = true;
            }

            totalstreamlength += value.length;
            streamBufferRef.current.push(chunk);

            if (state !== "playing") {
              kickOffBufferredPlayback();
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      if (error instanceof Error) {
        errorHandler(error);
      }
    }
  };

  const stopAudio = () => {
    // If we have an ongoing reader, cancel it
    setState("ready");
    stopRequestedRef.current = true;
    if (readerRef.current) {
      readerRef.current.cancel();
    }

    // Stop all audio processing
    if (scriptNodeRef.current) {
      scriptNodeRef.current.port.postMessage({
        type: "stop-processor",
      });
    }

    // Suspend the audio context
    if (audioContextRef.current) {
      audioContextRef.current.suspend();
    }
    streamBufferRef.current = [];
  };

  const handleFormSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setState("streaming");
    hasSkippedHeaderRef.current = false;

    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext ||
        window.webkitAudioContext)({
        sampleRate: 22050,
      });
    }

    const initAudioWorklet = async () => {
      try {
        if (audioContextRef.current) {
          // https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode/port#examples
          if (!isAudioWorkletModuleAdded) {
            console.log("adding audio worklet");
            await audioContextRef.current.audioWorklet.addModule(
              "/audio-processor.js"
            );
            isAudioWorkletModuleAdded = true;
          }
          if (!scriptNodeRef.current) {
            console.log("adding script node");
            scriptNodeRef.current = new AudioWorkletNode(
              audioContextRef.current,
              "audio-processor"
            );
            scriptNodeRef.current.connect(audioContextRef?.current.destination);
            scriptNodeRef.current.port.onmessage = (event) => {
              if (event.data.type === "playback-complete") {
                setState("ready");
              }
              if (event.data.type === "ready-for-next-chunk") {
                // queueMicrotask(() => {
                kickOffBufferredPlayback();
                // });
              }
            };
          }
        }
      } catch (error) {
        if (error instanceof Error) {
          errorHandler(error);
        }
      }
    };

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
      initAudioWorklet().then(() => {
        handleSynthesis(text);
      });
    } else {
      initAudioWorklet().then(() => {
        handleSynthesis(text);
      });
    }
  };

  return (
    <div className="flex flex-col h-screen">
      <div className="mb-auto mt-auto p-2 sm:p-4 md:p-6 lg:p-8">
        <Container>
          <Card className="shadow-xl md:p-4 lg:p-6 xl:p-8">
            <Flex asChild gap={"4"} direction={"column"} align={"center"}>
              <form
                onSubmit={(e) => {
                  handleFormSubmit(e);
                }}
              >
                <div className="relative self-stretch">
                  <label htmlFor="syn-text" className="sr-only">
                    Synthesize text
                  </label>
                  <TextArea
                    autoFocus
                    value={text}
                    onChange={(e) => {
                      if (ttfs !== 0 || networkTime !== 0) {
                        setTtfs(0);
                        setNetworkTime(0);
                      }
                      setText(e.target.value);
                    }}
                    onFocus={() => {
                      if (state === "error") {
                        setState("ready");
                      }
                    }}
                    disabled={state === "playing" || state === "streaming"}
                    className="self-stretch relative"
                    variant="soft"
                    size="3"
                    maxLength={2000}
                    rows={8}
                    name="syn-text"
                    id="syn-text"
                    placeholder="Resemble’s AI voice generator lets you create realistic human–like voiceovers in seconds."
                  />
                  {state === "streaming" && (
                    <div className="absolute bg-transparent z-10 top-1/3 left-1/2 flex items-center justify-center">
                      <div
                        role="status"
                        aria-live="polite"
                        className="flex items-center"
                      >
                        <svg
                          className="animate-spin h-8 w-8 text-green-800"
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          ></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          ></path>
                        </svg>
                        <span className="sr-only">Loading...</span>
                      </div>
                    </div>
                  )}
                </div>

                <Badge className="tabular-nums self-end">
                  {text.length} / {MAX_TEXT_LENGTH}
                </Badge>

                <Flex gap={"3"} align={"center"}>
                  {state === "ready" && (
                    <Button type="submit">
                      <Flex gap={"2"} align={"center"}>
                        Synthesize
                        <PlayIcon aria-hidden />
                      </Flex>
                    </Button>
                  )}
                  {state === "error" && (
                    <Button type="submit">
                      <Flex gap={"2"} align={"center"}>
                        Retry
                        <ReloadIcon aria-hidden />
                      </Flex>
                    </Button>
                  )}
                  {state === "streaming" && (
                    <Button type="button" onClick={stopAudio}>
                      <Flex gap={"2"} align={"center"}>
                        Cancel
                        <Cross1Icon aria-hidden />
                      </Flex>
                    </Button>
                  )}
                  {state === "playing" && (
                    <Button type="button" onClick={stopAudio}>
                      <Flex gap={"2"} align={"center"}>
                        Stop
                        <StopIcon aria-hidden />
                      </Flex>
                    </Button>
                  )}
                </Flex>

                <FormFooter ttfs={ttfs} networkTime={networkTime} />
              </form>
            </Flex>
          </Card>
        </Container>
      </div>
      <Footer />
    </div>
  );
}

type FormFooterProps = {
  ttfs: number;
  networkTime: number;
};
const FormFooter = ({ ttfs, networkTime }: FormFooterProps) => {
  return (
    <Flex
      justify={"between"}
      align={"start"}
      className="self-stretch"
      wrap={"wrap"}
      gap={"4"}
    >
      {
        <Badge size={"2"} className="!flex !gap-8">
          <span className="flex gap-1 items-center">
            <Text color="green">Server time</Text>
            <Tooltip content="Time our server took for generating first chunk in the stream.">
              <InfoCircledIcon color="green" />
            </Tooltip>
          </span>
          <Badge color="gold" variant="surface">
            <span>{ttfs} ms</span>
          </Badge>
        </Badge>
      }
      {
        <Badge size={"2"} className="!flex !gap-8">
          <span className="flex gap-1 items-center">
            <Text color="green">Network time</Text>
            <Tooltip content="Time taken, including network delay to generate the first chunk">
              <InfoCircledIcon color="green" />
            </Tooltip>
          </span>
          <Badge color="gold" variant="surface">
            <span>{networkTime} ms</span>
          </Badge>
        </Badge>
      }
    </Flex>
  );
};

const Footer = () => {
  return (
    <footer className="w-full py-4 mt-2 text-center">
      <a href="https://www.resemble.ai" aria-label="Visit Resemble AI website">
        <img
          src="https://www.resemble.ai/wp-content/uploads/2021/05/logo.webp"
          alt="Resemble AI Logo"
          className="mx-auto mt-2 w-48"
        />
      </a>
    </footer>
  );
};
