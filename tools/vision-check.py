#!/usr/bin/env python3
"""vision-check.py - send an image to a running Strata server and check the answer mechanically.

Why this exists
---------------
DSH's local delegation (`delegate_batch`) carries **text only**: its schema is
{tasks:[{description, prompt, verify}]} with no field for an image, and the local model has no tools and
cannot read a path itself.  So an image cannot travel through that route.

The engine, however, does read images: `serve/server.py` accepts OpenAI `image_url` parts and Anthropic
image blocks, as base64 data, an http(s) URL, or a **local file path**.  This script is the bridge - it
runs on the same machine, reads the image, calls the server, and answers with a machine-decidable
verdict.  Any tool-capable agent (including a DSH subagent, which inherits the full tool list) can call
it, so vision work reaches the local model and stays verifiable.

Usage
-----
    python tools/vision-check.py IMAGE [IMAGE...] --ask "question" [--check STR [--check STR ...]]
                                     [--url http://127.0.0.1:8080] [--max-tokens N] [--think LEVEL]

    # read the text off a screenshot, pass only if both strings are present
    python tools/vision-check.py shot.png --ask "Read the text. Two lines, nothing else." \
        --check "MEN WALK ON MOON" --check "SAMPLE 42 DELTA"

With --check the exit code is 0 when every needle was found (useful as a verifier), 1 otherwise;
without --check it prints the reading and exits 0 (use it to look at the answer, not to judge it).
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
import sys
import time
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8080"


def data_url(path: Path) -> str:
    """Inline the image exactly as the OpenAI wire format wants it (server also accepts bare paths)."""
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def read(url: str, images: list[Path], question: str, max_tokens: int, effort: str,
         timeout: float) -> dict:
    content: list[dict] = [{"type": "image_url", "image_url": {"url": data_url(p)}} for p in images]
    content.append({"type": "text", "text": question})
    body = {
        "model": "strata",
        "messages": [{"role": "user", "content": content}],
        "temperature": 0,
        "reasoning_effort": effort,
        "max_tokens": max_tokens,
        "stream": False,
    }
    req = urllib.request.Request(f"{url.rstrip('/')}/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    wall = time.time() - t0
    msg = out["choices"][0]["message"]
    # A budget spent entirely on reasoning leaves content null; the reasoning text is still a reading.
    answer = (msg.get("content") or "").strip()
    reasoning = (msg.get("reasoning_content") or "").strip()
    t = out.get("timings") or {}
    return {"answer": answer, "reasoning": reasoning, "wall": wall,
            "prompt_n": t.get("prompt_n"), "finish": out["choices"][0].get("finish_reason"),
            "truncated": not answer and bool(reasoning)}


def squash(s: str) -> str:
    return re.sub(r"[^0-9a-z]+", "", s.lower())


def main() -> int:
    ap = argparse.ArgumentParser(description="Ask a running Strata server about an image, and check it.")
    ap.add_argument("images", nargs="+", type=Path)
    ap.add_argument("--ask", required=True, help="the question to put to the model")
    ap.add_argument("--check", action="append", default=[],
                    help="a string the reading must contain (case/punctuation-insensitive); repeatable")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--max-tokens", type=int, default=300)
    ap.add_argument("--think", default="none", choices=["none", "low", "medium", "high"])
    ap.add_argument("--timeout", type=float, default=600.0)
    a = ap.parse_args()

    for p in a.images:
        if not p.is_file():
            print(f"FAIL no such image: {p}", file=sys.stderr)
            return 2
    try:
        r = read(a.url, a.images, a.ask, a.max_tokens, a.think, a.timeout)
    except Exception as e:                                     # noqa: BLE001
        print(f"FAIL request error: {type(e).__name__} {e}", file=sys.stderr)
        return 2

    shown = r["answer"] or r["reasoning"]
    print(f"images={len(a.images)} wall={r['wall']:.2f}s prompt_n={r['prompt_n']} "
          f"finish={r['finish']}" + ("  [answer fell back to reasoning]" if r["truncated"] else ""))
    print(f"reading: {shown}")
    if not a.check:
        return 0

    low = squash(shown)
    missing = [c for c in a.check if squash(c) not in low]
    for c in a.check:
        print(f"  {'ok  ' if squash(c) in low else 'MISS'} {c!r}")
    if missing:
        print(f"VERDICT fail - {len(missing)}/{len(a.check)} not found")
        return 1
    print(f"VERDICT pass - {len(a.check)}/{len(a.check)} found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
