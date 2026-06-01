"""DeepSeek API client (stdlib only).

Adapted from concepts in hustcer/deepseek-review (Nushell upstream).
Used by ds-verify; ds-review's embedded equivalent will migrate onto this
in a later phase.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request


class DeepSeekError(RuntimeError):
    """Surfaces API/transport failures with a short reason."""


def call_chat(
    api_key,
    base_url,
    model,
    system_prompt,
    user_content,
    temperature=0.3,
    timeout=600,
):
    """POST a chat completion to the DeepSeek (OpenAI-compatible) endpoint.

    Returns the assistant's text content. Raises DeepSeekError on any
    transport, decoding, or shape failure. Never logs or echoes the api_key.
    """
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": temperature,
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "ds-verify/1.0 (osborn-capability)",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise DeepSeekError(f"HTTP {e.code} from {url}\n{body_text[:1000]}")
    except urllib.error.URLError as e:
        raise DeepSeekError(f"network error contacting {url}: {e.reason}")
    except Exception as e:
        raise DeepSeekError(f"unexpected request error: {e}")

    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        raise DeepSeekError(f"non-JSON response from API:\n{data[:500]}")

    try:
        content = parsed["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise DeepSeekError(f"unexpected API response shape:\n{data[:500]}")

    if not isinstance(content, str) or not content.strip():
        raise DeepSeekError("empty content in API response")
    return content
