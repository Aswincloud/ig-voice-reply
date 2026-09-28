// ElevenLabs returns raw 16-bit little-endian PCM when asked for pcm_<rate>.
// Instagram accepts aac, m4a, wav or mp4 — not raw PCM and not MP3. A WAV file
// is that same PCM with a 44-byte RIFF header in front, so this is the whole
// transcoding step. No ffmpeg, which is what keeps the Worker serverless.
export function pcmToWav(
  pcm: ArrayBuffer,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
): ArrayBuffer {
  const dataLen = pcm.byteLength;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const out = new ArrayBuffer(44 + dataLen);
  const v = new DataView(out);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true); // file size minus the 8 bytes of "RIFF"+size
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk length
  v.setUint16(20, 1, true); // 1 = PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  v.setUint32(40, dataLen, true);
  new Uint8Array(out, 44).set(new Uint8Array(pcm));
  return out;
}
