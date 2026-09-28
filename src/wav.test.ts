import { test } from "node:test";
import assert from "node:assert/strict";
import { pcmToWav } from "./wav.ts";

const ascii = (buf: ArrayBuffer, off: number, len: number) =>
  String.fromCharCode(...new Uint8Array(buf, off, len));

test("header is exactly 44 bytes and the PCM follows it untouched", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
  const wav = pcmToWav(pcm, 24000);
  assert.equal(wav.byteLength, 44 + 6);
  assert.deepEqual([...new Uint8Array(wav, 44)], [1, 2, 3, 4, 5, 6]);
});

test("RIFF/WAVE/fmt/data markers and sizes are right for 24 kHz mono 16-bit", () => {
  const pcm = new ArrayBuffer(48000); // one second at 24 kHz, 16-bit mono
  const wav = pcmToWav(pcm, 24000);
  const v = new DataView(wav);
  assert.equal(ascii(wav, 0, 4), "RIFF");
  assert.equal(v.getUint32(4, true), 36 + 48000);
  assert.equal(ascii(wav, 8, 4), "WAVE");
  assert.equal(ascii(wav, 12, 4), "fmt ");
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1, "PCM format tag");
  assert.equal(v.getUint16(22, true), 1, "mono");
  assert.equal(v.getUint32(24, true), 24000, "sample rate");
  assert.equal(v.getUint32(28, true), 48000, "byte rate = rate * blockAlign");
  assert.equal(v.getUint16(32, true), 2, "block align");
  assert.equal(v.getUint16(34, true), 16, "bits per sample");
  assert.equal(ascii(wav, 36, 4), "data");
  assert.equal(v.getUint32(40, true), 48000);
});

test("empty PCM still yields a valid 44-byte header", () => {
  const wav = pcmToWav(new ArrayBuffer(0), 16000);
  assert.equal(wav.byteLength, 44);
  assert.equal(new DataView(wav).getUint32(40, true), 0);
});
