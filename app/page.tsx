/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, FormEvent, useRef, useEffect } from "react";
import { int16ArrayToFloat32Array } from "./utils";
import {
  Badge,
  Button,
  Container,
  Flex,
  Text,
  TextArea,
} from "@radix-ui/themes";
import Swal from "sweetalert2";

const BUFFER_SIZE = 128;
const INITIAL_BUFFER_SIZE = 500;
const WAV_HEADER_SIZE = 44;
const MAX_TEXT_LENGTH = 2000;
const decoder = new TextDecoder("utf-8");

export default function Home() {
  const [state, setState] = useState<
    "ready" | "streaming" | "playing" | "error"
  >("ready");
  const [text, setText] = useState("");
  const audioQueueRef = useRef<Float32Array[]>([]);
  const hasSkippedHeaderRef = useRef(false);
  const scriptNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
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

  const playAudioStream = async (response: Response) => {
    const reader = response.body?.getReader();
    readerRef.current = reader;

    if (reader) {
      reader
        .read()
        .then(function process({ done, value }) {
          // In our api implementation, we are streaming error messages if any
          try {
            const string = decoder.decode(value);
            if (string.includes("Error")) {
              setState("error");
              if (scriptNodeRef.current && scriptNodeRef.current.port) {
                scriptNodeRef.current.port.postMessage({
                  type: "stream-error",
                });
              }
              Swal.fire({
                title: "Error!",
                text: "Something went wrong. Please try reducing the number of sentences in your query and try again.",
                icon: "error",
              });
              return;
            }
          } catch (error) {}

          if (done) {
            // Signal the end of the audio stream
            if (scriptNodeRef.current && scriptNodeRef.current.port) {
              console.log('Sending "audio-end" message to Audio Worklet');
              scriptNodeRef.current.port.postMessage({ type: "audio-end" });
            }
            setState("ready");
            return;
          }

          if (!hasSkippedHeaderRef.current && value) {
            value = value.slice(WAV_HEADER_SIZE);
            hasSkippedHeaderRef.current = true;
            console.log("Header skipped, audio data begins:", value);
          }

          if (value) {
            const audioData = int16ArrayToFloat32Array(
              new Int16Array(value.buffer)
            );
            let startIdx = 0;

            while (startIdx < audioData.length) {
              const chunkSize = Math.min(
                audioData.length - startIdx,
                BUFFER_SIZE
              );
              const chunk = audioData.slice(startIdx, startIdx + chunkSize);

              audioQueueRef.current.push(chunk);
              startIdx += chunkSize;

              // // Check if the audio is playing and send the chunk to the worklet
              // if (
              //   !isPlayingRef.current &&
              //   audioQueueRef.current.length >= INITIAL_BUFFER_SIZE
              // ) {
              //   isPlayingRef.current = true;

              //   // empty the queue
              //   console.log("emptying the queue");
              //   for (let i = 0; i < INITIAL_BUFFER_SIZE; i++) {
              //     const chunk = audioQueueRef.current.shift();
              //     if (scriptNodeRef.current) {
              //       scriptNodeRef.current.port.postMessage({
              //         type: "audio-chunk",
              //         chunk,
              //       });
              //     }
              //   }
              // }

              if (scriptNodeRef.current) {
                scriptNodeRef.current.port.postMessage({
                  type: "audio-chunk",
                  chunk,
                });
              }
            }
            queueMicrotask(() => {
              reader.read().then(process);
            });
          }
        })
        .catch((error) => {
          console.log("Error reading audio stream:", error);
        });
    }
  };

  const handleSynthesis = async (text: string) => {
    if (scriptNodeRef.current && scriptNodeRef.current.port) {
      scriptNodeRef.current.port.postMessage({ type: "reset-processor" });
    }
    try {
      setState("streaming");
      const res = await fetch("/api/resemble", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: text }),
      });
      setState("playing");
      playAudioStream(res);
    } catch (error) {
      console.error("Error:", error);
    }
  };

  const handleFormSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // TODO: enforce character limit here and an error UI
    if (text.length === 0 || state === "streaming" || state === "playing") {
      return;
    }

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
        }
      } catch (error) {
        console.error("Error initializing audio worklet:", error);
      }
    };

    // If the scriptNode already exists, disconnect it to reset
    if (scriptNodeRef.current) {
      scriptNodeRef.current.disconnect();
      scriptNodeRef.current = null;
    }

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
      <div className="mb-auto mt-auto p-4">
        <Container>
          <Flex asChild gap={"3"} direction={"column"} align={"center"}>
            <form
              onSubmit={(e) => {
                handleFormSubmit(e);
              }}
            >
              <TextArea
                autoFocus
                value={text}
                onChange={(e) => {
                  if (+e.target.value <= MAX_TEXT_LENGTH) {
                    setText(e.target.value);
                  }
                }}
                onFocus={() => {
                  if (state === "error") {
                    setState("ready");
                  }
                }}
                disabled={state === "playing" || state === "streaming"}
                className="self-stretch"
                variant="soft"
                size="3"
                maxLength={2000}
                rows={5}
                name="syn-text"
                id="syn-text"
                placeholder="Write here..."
              />
              <Badge
                className="self-end tabular-nums"
                highContrast
                variant="surface"
              >
                {text.length} / {MAX_TEXT_LENGTH}
              </Badge>
              <Button type="submit" size={"3"}>
                {state === "ready" && "Start Streaming"}
                {state === "streaming" && "Synthesizing..."}
                {state === "playing" && "Playing..."}
                {state === "error" && "Retry"}
              </Button>
            </form>
          </Flex>
        </Container>
      </div>
      <footer className="w-full py-4 mt-4 text-center">
        <Text as="p" highContrast color="green" size={"4"}>
          Powered by Resemble.ai
        </Text>
        <img
          src="https://www.resemble.ai/wp-content/uploads/2021/05/logo.webp"
          alt="Resemble AI Logo"
          className="mx-auto w-32"
        />
      </footer>
    </div>
  );
}
