"""MkDocs hook: embed ZLens feature clips.

A page embeds a clip with a marker on a line of its own:

    {{ clip("quickstart") }}

The hook replaces the marker with a muted, looping <video> (WebM first, then
MP4, with a PNG poster) and a caption that repeats the clip's steps as text,
so the page reads the same without the video.

Clip files and captions are owned by the clip recording harness:

    docs/media/clips/<id>.webm
    docs/media/clips/<id>.mp4
    docs/media/clips/<id>.png          (poster)
    docs/media/clips/clips.yml         (id -> {title, caption, steps[]})

When the video files or the clips.yml entry are missing, the marker renders a
small "Clip coming soon" placeholder instead, so `mkdocs build --strict` keeps
passing while clips are still being recorded.
"""

from __future__ import annotations

import html
import logging
import os
import re
from typing import Any

import yaml
from mkdocs.utils import get_relative_url

log = logging.getLogger("mkdocs.hooks.clips")

CLIP_DIR = "media/clips"
MARKER = re.compile(r'^[ \t]*\{\{\s*clip\(\s*["\']([a-z0-9][a-z0-9-]*)["\']\s*\)\s*\}\}[ \t]*$', re.MULTILINE)
FENCE = re.compile(r"^[ \t]*(```|~~~)", re.MULTILINE)

# Titles used by the placeholder until clips.yml provides the real ones.
FALLBACK_TITLES = {
    "overview": "ZLens in one minute",
    "quickstart": "From install to a first result",
    "ask-certified": "A question answered by a certified block",
    "ask-review": "An answer that needs review, and its saved draft",
    "ask-refusal": "A question Ask refuses, with the reason",
    "import-certify": "Import SQL, save the draft, certify it",
    "notebook": "A notebook with SQL and DQL cells",
    "app-ask": "Read an App, change a filter, ask about it",
    "lineage": "From dbt models to blocks to Apps",
    "mcp-connect": "Connect Claude Code with zlens connect",
}

_clips_cache: dict[str, Any] | None = None


def _load_clips(docs_dir: str) -> dict[str, Any]:
    global _clips_cache
    if _clips_cache is not None:
        return _clips_cache
    path = os.path.join(docs_dir, CLIP_DIR, "clips.yml")
    data: dict[str, Any] = {}
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as fh:
                loaded = yaml.safe_load(fh) or {}
            if isinstance(loaded, dict):
                # Accept either a top-level map or {clips: {...}}.
                data = loaded.get("clips", loaded) if isinstance(loaded.get("clips"), dict) else loaded
        except yaml.YAMLError as exc:  # keep the build green; show placeholders
            log.warning("clips.yml could not be parsed (%s); rendering placeholders", exc)
    _clips_cache = data
    return data


def on_config(config, **kwargs):
    global _clips_cache
    _clips_cache = None  # re-read on every build (mkdocs serve reloads)
    return config


def _caption(entry: dict[str, Any], title: str) -> str:
    parts = [f'<strong class="zlens-clip__title">{html.escape(title)}</strong>']
    caption = entry.get("caption")
    if caption:
        parts.append(f"<span class=\"zlens-clip__caption\">{html.escape(str(caption))}</span>")
    steps = [s for s in (entry.get("steps") or []) if s]
    if steps:
        items = "".join(f"<li>{html.escape(str(s))}</li>" for s in steps)
        parts.append(f'<ol class="zlens-clip__steps">{items}</ol>')
    return "<figcaption>" + " ".join(parts) + "</figcaption>"


def _render(clip_id: str, page_url: str, docs_dir: str) -> str:
    clips = _load_clips(docs_dir)
    entry = clips.get(clip_id)
    entry = entry if isinstance(entry, dict) else {}
    title = str(entry.get("title") or FALLBACK_TITLES.get(clip_id) or clip_id)

    def exists(ext: str) -> bool:
        return os.path.isfile(os.path.join(docs_dir, CLIP_DIR, f"{clip_id}.{ext}"))

    def url(ext: str) -> str:
        return html.escape(get_relative_url(f"{CLIP_DIR}/{clip_id}.{ext}", page_url))

    has_video = exists("mp4") or exists("webm")
    if not (has_video and entry):
        return (
            f'<figure class="zlens-clip zlens-clip--pending" data-clip="{html.escape(clip_id)}">'
            f'<div class="zlens-clip__placeholder" role="img" aria-label="Clip coming soon: {html.escape(title)}">'
            f'<span class="zlens-clip__badge">Clip coming soon</span>'
            f'<span class="zlens-clip__placeholder-title">{html.escape(title)}</span>'
            f"</div>"
            f"{_caption(entry, title) if entry else ''}"
            f"</figure>"
        )

    poster = f' poster="{url("png")}"' if exists("png") else ""
    sources = ""
    if exists("webm"):
        sources += f'<source src="{url("webm")}" type="video/webm">'
    if exists("mp4"):
        sources += f'<source src="{url("mp4")}" type="video/mp4">'
    return (
        f'<figure class="zlens-clip" data-clip="{html.escape(clip_id)}">'
        f'<video autoplay muted loop playsinline preload="metadata"{poster} aria-label="{html.escape(title)}">'
        f"{sources}</video>"
        f"{_caption(entry, title)}"
        f"</figure>"
    )


def _outside_fences(markdown: str):
    """Yield (start, end) spans of the page that are not inside fenced code."""
    pos, inside, start = 0, False, 0
    for m in FENCE.finditer(markdown):
        if not inside:
            yield (start, m.start())
            inside = True
        else:
            inside = False
            start = markdown.find("\n", m.end())
            start = len(markdown) if start == -1 else start
    if not inside:
        yield (start, len(markdown))


def on_page_markdown(markdown: str, page, config, files, **kwargs) -> str:
    if "clip(" not in markdown:
        return markdown
    docs_dir = config["docs_dir"]
    out, last = [], 0
    for start, end in _outside_fences(markdown):
        segment = markdown[start:end]
        out.append(markdown[last:start])
        out.append(MARKER.sub(lambda m: "\n" + _render(m.group(1), page.url, docs_dir) + "\n", segment))
        last = end
    out.append(markdown[last:])
    return "".join(out)
