"""Int16 PCM → Opus encoder.

Pipes signed-16-bit little-endian PCM bytes (as produced by Piper) into
ffmpeg via stdin and streams the Opus-in-Ogg output back out. Async so
the FastAPI handler stays non-blocking while ffmpeg runs.

Why s16le and not f32le: Piper's AudioChunk exposes int16 PCM directly
(`chunk.audio_int16_bytes`). Skipping the float→int16 conversion means
fewer allocations on the hot path.
"""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator, Tuple

from metrics import ffmpeg_errors_total

log = logging.getLogger(__name__)

CHANNELS = 1


def _ffmpeg_args(sample_rate: int) -> tuple[str, ...]:
    return (
        'ffmpeg',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', str(sample_rate),
        '-ac', str(CHANNELS),
        '-i', 'pipe:0',
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-application', 'voip',
        '-frame_duration', '60',
        # Flush packets as they're produced rather than buffering whole
        # ogg pages — required for the streaming path to actually start
        # sending bytes before the encoder finishes the full input.
        '-flush_packets', '1',
        '-f', 'opus',
        'pipe:1',
    )


class EncodeError(RuntimeError):
    """Raised when ffmpeg exits non-zero or fails to produce output."""


async def encode_opus_stream(
    chunks: 'AsyncIterator[Tuple[int, bytes]]',
) -> 'AsyncIterator[bytes]':
    """Encode a stream of (sample_rate, int16_le_bytes) tuples into a
    continuous Opus-in-Ogg stream.

    The first chunk's sample_rate is used to configure ffmpeg. We assume
    every subsequent chunk has the same sample rate (true for a single
    Piper voice; mixing rates mid-stream isn't a use case we support).
    """
    proc: asyncio.subprocess.Process | None = None
    pump_task: asyncio.Task | None = None
    sample_rate: int | None = None

    async def _pump_in() -> None:
        try:
            assert proc is not None and proc.stdin is not None
            async for sr, pcm in chunks_iter:
                if not pcm:
                    continue
                proc.stdin.write(pcm)
                await proc.stdin.drain()
        except Exception as exc:
            ffmpeg_errors_total.labels(kind='stream_eof').inc()
            log.warning('encode pump errored', extra={'reason': str(exc)})
        finally:
            if proc is not None and proc.stdin is not None:
                try:
                    proc.stdin.close()
                    await proc.stdin.wait_closed()
                except Exception:
                    pass

    chunks_iter = chunks.__aiter__()
    try:
        first = await chunks_iter.__anext__()
    except StopAsyncIteration:
        return

    sample_rate, first_pcm = first
    try:
        proc = await asyncio.create_subprocess_exec(
            *_ffmpeg_args(sample_rate),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception:
        ffmpeg_errors_total.labels(kind='spawn').inc()
        raise
    assert proc.stdin is not None and proc.stdout is not None

    # Push the first chunk before kicking off the pump task so we don't
    # race the pump on stdin writes.
    proc.stdin.write(first_pcm)
    try:
        await proc.stdin.drain()
    except Exception:
        pass

    pump_task = asyncio.create_task(_pump_in())

    try:
        while True:
            data = await proc.stdout.read(4096)
            if not data:
                break
            yield data
    finally:
        if pump_task is not None:
            try:
                await pump_task
            except Exception as exc:
                log.warning('encode pump failed', extra={'reason': str(exc)})

        rc = await proc.wait()
        if rc != 0:
            ffmpeg_errors_total.labels(kind='exit_nonzero').inc()
            stderr = b''
            try:
                stderr = await proc.stderr.read() if proc.stderr else b''
            except Exception:
                pass
            err = stderr.decode('utf-8', errors='replace').strip()
            log.error(
                'ffmpeg streaming encode failed',
                extra={'returncode': rc, 'stderr': err[:500]},
            )
