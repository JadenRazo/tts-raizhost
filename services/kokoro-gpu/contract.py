"""Dependency-free input contract shared by the HTTP and metrics layers."""

from __future__ import annotations

import re

_CONTROL_CHARS = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')
_UNICODE_WHITESPACE = re.compile(
    '[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]'
)
_INVISIBLE_CHARS = re.compile(
    '[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]'
)


def sanitize_for_synth(text: str) -> str:
    """Strip unsafe controls/invisibles and normalize horizontal whitespace."""
    sanitized = _CONTROL_CHARS.sub('', text)
    sanitized = _INVISIBLE_CHARS.sub('', sanitized)
    sanitized = _UNICODE_WHITESPACE.sub(' ', sanitized)
    return re.sub(r'[ \t]+', ' ', sanitized).strip()


def text_len_bucket(text_length: int) -> str:
    """Map text length to a bounded-cardinality Prometheus label."""
    if text_length < 50:
        return 'xs'
    if text_length < 200:
        return 's'
    if text_length < 500:
        return 'm'
    if text_length < 1000:
        return 'l'
    return 'xl'
