/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, FormEvent, useRef, useEffect } from "react";
import {
  inspectLast10ValuesInChunks,
  int16ArrayToFloat32Array,
  padAudioData,
} from "./utils";
import {
  Badge,
  Button,
  Container,
  Flex,
  Text,
  TextArea,
  Link,
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

export default function Home() {
  const [state, setState] = useState<
    "ready" | "streaming" | "playing" | "error"
  >("ready");
  const [text, setText] = useState("");
  const [ttfs, setTtfs] = useState(0);
  const [networkTime, setNetworkTime] = useState(0);

  const audioQueueRef = useRef<Float32Array[]>([]);
  const hasSkippedHeaderRef = useRef(false);
  const hasReadMetadataRef = useRef(false);
  const scriptNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const stopRequestedRef = useRef(false);
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

  const playAudioStream = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    startTime: number
  ) => {
    readerRef.current = reader;

    if (readerRef.current) {
      readerRef.current
        .read()
        .then(function process({ done, value }) {
          if (stopRequestedRef.current) {
            return;
          }

          if (done) {
            // Signal the end of the audio stream
            if (scriptNodeRef.current && scriptNodeRef.current.port) {
              console.log('Sending "audio-end" message to Audio Worklet');
              scriptNodeRef.current.port.postMessage({ type: "audio-end" });
            }
            return;
          }

          // read streaming metadata
          if (!hasReadMetadataRef.current && value) {
            const metadataView = new DataView(value.buffer, 0, 8); // Adjust size if needed (i.e if you added more metadata to the response)
            const timeToFirstSound = metadataView.getFloat64(0, true);
            setTtfs(Math.round(timeToFirstSound));
            setNetworkTime(Math.round(performance.now() - startTime));
            hasReadMetadataRef.current = true;
            value = value.slice(8);
          }

          // skip wav header
          if (!hasSkippedHeaderRef.current && value) {
            value = value.slice(WAV_HEADER_SIZE);
            hasSkippedHeaderRef.current = true;
            console.log("Header skipped, audio data begins:", value);
          }

          // process audio data
          if (value) {
            const paddedData = padAudioData(value.buffer);
            console.log(inspectLast10ValuesInChunks(paddedData));
            const audioData = int16ArrayToFloat32Array(paddedData);
            let startIdx = 0;

            while (startIdx < audioData.length) {
              const chunkSize = Math.min(
                audioData.length - startIdx,
                BUFFER_SIZE
              );
              const chunk = audioData.slice(startIdx, startIdx + chunkSize);

              audioQueueRef.current.push(chunk);
              startIdx += chunkSize;

              if (state !== "playing") {
                setState("playing");
              }
              if (scriptNodeRef.current) {
                scriptNodeRef.current.port.postMessage({
                  type: "audio-chunk",
                  chunk,
                });
              }
            }
            if (!stopRequestedRef.current) {
              queueMicrotask(() => {
                readerRef.current?.read().then(process).catch(errorHandler);
              });
            }
          }
        })
        .catch(errorHandler);
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
    audioQueueRef.current = [];
    stopRequestedRef.current = false;
    hasSkippedHeaderRef.current = false;
    hasReadMetadataRef.current = false;

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
        playAudioStream(readerRef.current, startTime);
      }
    } catch (error) {
      console.error("Error:", error);
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
    audioQueueRef.current = [];
  };

  const handleFormSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (text.length === 0 || state === "streaming" || state === "playing") {
      return;
    }

    setTtfs(0);
    setNetworkTime(0);

    hasSkippedHeaderRef.current = false;
    audioQueueRef.current = [];

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
          await audioContextRef.current?.audioWorklet.addModule(
            "/audio-processor.js"
          );
          scriptNodeRef.current = new AudioWorkletNode(
            audioContextRef.current,
            "audio-processor"
          );
          scriptNodeRef.current.connect(audioContextRef?.current.destination);
          scriptNodeRef.current.port.onmessage = (event) => {
            if (event.data.type === "playback-complete") {
              setState("ready");
            }
          };
        }
      } catch (error) {
        console.error("Error initializing audio worklet:", error);
      }
    };

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
      initAudioWorklet();
    } else {
      initAudioWorklet();
    }

    setState("streaming");
    await handleSynthesis(text);
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
