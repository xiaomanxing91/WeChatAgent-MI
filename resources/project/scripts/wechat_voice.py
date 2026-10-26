#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WeChatAgent 语音生成器：文本 -> SILK_V3，落到 state/generated-voices/<sha256>.silk

输出 JSON（stdout）：
  {"ok":true,"path":"...\\<sha256>.silk","duration":4800,"sha256":"...","bytes":12687}
失败：
  {"ok":false,"error":"..."}

用法:
  python wechat_voice.py "<文本>" [--voice zh-CN-XiaoxiaoNeural] [--root <workspace>]
  python wechat_voice.py --wav <in.wav> [--root <workspace>]
"""
import sys, os, json, asyncio, wave, tempfile, hashlib, argparse

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
DEFAULT_ROOT = r"C:\Users\star\AppData\Roaming\WeChatAgent\workspace"


def tts_mp3(text: str, voice: str) -> bytes:
    import edge_tts
    async def _run():
        c = edge_tts.Communicate(text, voice)
        buf = bytearray()
        async for chunk in c.stream():
            if chunk["type"] == "audio":
                buf += chunk["data"]
        return bytes(buf)
    data = asyncio.run(_run())
    if not data:
        raise RuntimeError("edge-tts returned empty audio")
    return data


def mp3_to_wav(mp3_bytes: bytes, rate: int = 24000):
    import miniaudio
    dec = miniaudio.decode(mp3_bytes,
        output_format=miniaudio.SampleFormat.SIGNED16, nchannels=1, sample_rate=rate)
    return bytes(memoryview(dec.samples).cast("B")), dec.num_frames * 1000 // rate


def wav_bytes_to_pcm(wav_path: str, rate: int = 24000):
    """读 wav 并（如需）重采样到 rate，返回 (pcm_bytes, duration_ms)"""
    import miniaudio
    dec = miniaudio.decode_file(wav_path,
        output_format=miniaudio.SampleFormat.SIGNED16, nchannels=1, sample_rate=rate)
    return bytes(memoryview(dec.samples).cast("B")), dec.num_frames * 1000 // rate


def write_wav(pcm: bytes, path: str, rate: int = 24000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(pcm)


def pcm_to_silk(pcm: bytes, rate: int = 24000) -> bytes:
    """用 pilk 编码 PCM -> SILK_V3（pilk.encode 需要文件路径）"""
    import pilk
    fd_in, wav_in = tempfile.mkstemp(suffix=".wav"); os.close(fd_in)
    fd_out, silk_out = tempfile.mkstemp(suffix=".silk"); os.close(fd_out)
    try:
        write_wav(pcm, wav_in, rate)
        pilk.encode(wav_in, silk_out)
        return open(silk_out, "rb").read()
    finally:
        for p in (wav_in, silk_out):
            try: os.remove(p)
            except OSError: pass


def emit(payload: dict, code: int = 0):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="?", default=None)
    ap.add_argument("--wav", default=None)
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--root", default=DEFAULT_ROOT)
    args = ap.parse_args()

    try:
        if args.wav:
            pcm, duration = wav_bytes_to_pcm(args.wav)
        elif args.text:
            mp3 = tts_mp3(args.text, args.voice)
            pcm, duration = mp3_to_wav(mp3)
        else:
            emit({"ok": False, "error": "text or --wav required"}, 2)

        if duration <= 0:
            emit({"ok": False, "error": "empty audio"}, 3)
        if duration > 10 * 60 * 1000:
            emit({"ok": False, "error": "audio too long (>10min)"}, 4)

        silk = pcm_to_silk(pcm)
        if not silk.startswith(b"#!SILK_V3"):
            emit({"ok": False, "error": "silk encode failed (bad magic)"}, 5)

        digest = hashlib.sha256(silk).hexdigest()
        out_dir = os.path.join(args.root, "state", "generated-voices")
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, digest + ".silk")
        with open(out_path, "wb") as f:
            f.write(silk)
        emit({"ok": True, "path": out_path, "duration": duration,
              "sha256": digest, "bytes": len(silk)})
    except Exception as exc:
        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}, 1)


if __name__ == "__main__":
    main()
