"""
Narration for the promo video.

Synthesises each script line as its own clip and concatenates them with a fixed
gap, rather than synthesising the whole script in one pass and trying to find
the line boundaries afterwards. Word-level timings exist, but matching them back
to source lines means assuming the model kept the same tokens, and it does not
always: "Control C" and similar get normalised. Per-line synthesis makes each
line's start and end exact by construction.

Run with the media-tools venv python, which is the only one with Kokoro:

  ~/.local/media-tools/Scripts/python.exe tools/promo-vo.py <script.json> <outdir>

Writes vo.wav plus timeline.json, which carries the start and end of every line
so the renderer can cut scenes and show captions on the same clock.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".local" / "media-tools"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

from kokoro_tts import synth  # noqa: E402

SR = 24000


def main() -> None:
    script_path, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)

    spec = json.loads(script_path.read_text(encoding="utf-8"))
    voice = spec.get("voice", "af_heart")
    speed = spec.get("speed", 1.05)
    gap = float(spec.get("gap", 0.22))

    chunks: list[np.ndarray] = []
    timeline = []
    cursor = 0.0
    silence = np.zeros(int(SR * gap), dtype=np.float32)

    for index, line in enumerate(spec["lines"]):
        clip_path = outdir / f"line-{index:02d}.wav"
        synth(line["text"], str(clip_path), voice=voice, speed=speed)

        audio, rate = sf.read(clip_path, dtype="float32")
        if rate != SR:
            raise SystemExit(f"line {index} came back at {rate} Hz, expected {SR}")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        duration = len(audio) / SR
        timeline.append(
            {
                "index": index,
                "scene": line["scene"],
                "text": line["text"],
                "start": round(cursor, 3),
                "end": round(cursor + duration, 3),
            }
        )
        chunks.append(audio)
        chunks.append(silence)
        cursor += duration + gap
        print(f"  line {index:02d}  {duration:5.2f}s  {line['text'][:52]}")

    # A short tail so the outro is not cut off the instant the last word lands.
    chunks.append(np.zeros(int(SR * 1.6), dtype=np.float32))
    total = cursor + 1.6

    sf.write(outdir / "vo.wav", np.concatenate(chunks), SR)
    (outdir / "timeline.json").write_text(
        json.dumps({"total": round(total, 3), "lines": timeline}, indent=2),
        encoding="utf-8",
    )
    print(f"\n  vo.wav  {total:.2f}s  ({len(timeline)} lines, voice {voice})")


if __name__ == "__main__":
    main()
