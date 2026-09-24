#!/usr/bin/env python3
import base64
import cgi
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from PIL import Image, ImageOps
    PIL_AVAILABLE = True
except Exception:
    Image = None
    ImageOps = None
    PIL_AVAILABLE = False

CONFIG = {
    "host": os.getenv("HOST", "127.0.0.1"),
    "port": int(os.getenv("PORT", "8791")),
    "upstream_base_url": os.getenv("LK888_BASE_URL", "https://api.lk888.ai").rstrip("/"),
    "upstream_model": os.getenv("LK888_MODEL", "tt-image-2"),
    "banana_upstream_model": os.getenv("LK888_BANANA_MODEL", "banana-2"),
    "upstream_api_key": os.getenv("LK888_API_KEY", ""),
    "request_timeout": float(os.getenv("LK888_REQUEST_TIMEOUT_SECONDS", "120")),
    "poll_timeout": float(os.getenv("LK888_POLL_TIMEOUT_SECONDS", "600")),
    "poll_interval": float(os.getenv("LK888_POLL_INTERVAL_SECONDS", "3")),
    "max_body_bytes": int(os.getenv("MAX_BODY_BYTES", str(120 * 1024 * 1024))),
    "max_upstream_image_bytes": int(os.getenv("LK888_MAX_UPSTREAM_IMAGE_BYTES", "9500000")),
    "max_input_images": int(os.getenv("MAX_INPUT_IMAGES", "4")),
    "max_banana_input_images": int(os.getenv("MAX_BANANA_INPUT_IMAGES", "14")),
    "max_n": int(os.getenv("MAX_N", "1")),
    "forward_quality": os.getenv("LK888_FORWARD_QUALITY", "").lower() in {"1", "true", "yes", "on"},
    "compress_input_images": os.getenv("LK888_COMPRESS_INPUT_IMAGES", "true").lower() not in {"0", "false", "no", "off"},
    "log_file": os.getenv("LK888_ADAPTER_LOG", "/opt/jingyin-lk888-gpt-image-adapter/adapter.log"),
}

SUCCESS_STATUSES = {"SUCCESS", "SUCCESSFUL", "SUCCEED", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE", "FINISHED", "OK", "READY", "成功", "已成功", "已完成", "完成", "生成成功", "生成完成"}
FAILED_STATUSES = {"FAILURE", "FAILED", "FAIL", "ERROR", "ERRORED", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED", "EXPIRED", "失败", "已失败", "生成失败", "错误", "取消", "已取消", "超时", "拒绝"}
GPT_IMAGE_SIZE_LABELS = {"1K", "2K"}
GPT_SUPPORTED_ASPECT_RATIOS = ("1:1", "3:4", "4:3", "9:16", "16:9")


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "JingyinLK888Adapter/0.1"

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path in {"/health", "/healthz"}:
                return self.send_json(200, {"ok": True, "adapter": "lk888-image", "model": CONFIG["upstream_model"], "banana_model": CONFIG["banana_upstream_model"]})
            if parsed.path == "/v1/models":
                return self.send_json(200, {
                    "object": "list",
                    "data": [
                        {"id": "gpt-image", "object": "model", "owned_by": "jingyin-lk888-adapter"},
                        {"id": "gpt-image-2", "object": "model", "owned_by": "jingyin-lk888-adapter"},
                        {"id": "nano-banana2", "object": "model", "owned_by": "jingyin-lk888-adapter"},
                        {"id": "banana-2", "object": "model", "owned_by": "jingyin-lk888-adapter"},
                    ],
                })
            self.send_json(404, {"error": {"message": "not_found", "type": "not_found"}})
        except Exception as exc:
            self.handle_error(exc)

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path not in {"/v1/images/generations", "/v1/images/edits"}:
                return self.send_json(404, {"error": {"message": "not_found", "type": "not_found"}})
            incoming = normalize_request(self)
            n = clamp_int(incoming["fields"].get("n") or incoming["fields"].get("count") or 1, 1, CONFIG["max_n"])
            outputs = []
            upstream_meta = []
            for _ in range(n):
                result = generate_one(incoming, self.headers.get("Authorization", ""))
                outputs.extend(result["images"])
                upstream_meta.append(result["meta"])
            self.send_json(200, openai_image_response(outputs, upstream_meta))
        except Exception as exc:
            self.handle_error(exc)

    def log_message(self, fmt, *args):
        log("access", {"client": self.client_address[0], "message": fmt % args})

    def handle_error(self, exc):
        status = getattr(exc, "status", 500)
        message = getattr(exc, "message", str(exc) or "internal_error")
        safe_message = message if status < 500 else "lk888_adapter_error"
        log("request_failed", {"status": status, "error": message, "path": self.path})
        self.send_json(status, {"error": {"message": safe_message, "type": "lk888_adapter_error"}})

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def normalize_request(handler):
    body, content_length, body_source = read_request_body(handler)
    content_type = handler.headers.get("Content-Type", "")
    log("request_received", {
        "path": handler.path,
        "contentLength": content_length,
        "bodySource": body_source,
        "contentType": content_type[:120],
        "transferEncoding": handler.headers.get("Transfer-Encoding", "")[:80],
    })
    if "multipart/form-data" in content_type:
        return parse_multipart(body, content_type)
    if "application/x-www-form-urlencoded" in content_type:
        params = urllib.parse.parse_qs(body.decode("utf-8"), keep_blank_values=True)
        fields = {key: values[0] if len(values) == 1 else values for key, values in params.items()}
        return {"fields": fields, "images": image_inputs_from_fields(fields), "meta": {"content_type": content_type}}
    text = body.decode("utf-8").strip()
    fields = json.loads(text) if text else {}
    fields = fields if isinstance(fields, dict) else {}
    return {"fields": fields, "images": image_inputs_from_fields(fields), "meta": {"content_type": content_type}}


def read_request_body(handler):
    transfer_encoding = str(handler.headers.get("Transfer-Encoding") or "").lower()
    if "chunked" in transfer_encoding:
        body, too_large = read_chunked_body(handler, CONFIG["max_body_bytes"])
        if too_large:
            log_request_too_large(handler, len(body), "chunked")
            raise HttpError(413, "request_body_too_large")
        return body, len(body), "chunked"
    content_length = int(handler.headers.get("Content-Length") or "0")
    if content_length > CONFIG["max_body_bytes"]:
        discard_body(handler, content_length)
        log_request_too_large(handler, content_length, "content-length")
        raise HttpError(413, "request_body_too_large")
    return handler.rfile.read(content_length), content_length, "content-length"


def read_chunked_body(handler, max_body_bytes):
    chunks = []
    total = 0
    too_large = False
    while True:
        line = handler.rfile.readline(8192)
        if not line:
            raise HttpError(400, "invalid_chunked_body")
        try:
            size_text = line.split(b";", 1)[0].strip()
            size = int(size_text, 16)
        except Exception:
            raise HttpError(400, "invalid_chunked_body")
        if size == 0:
            while True:
                trailer = handler.rfile.readline(8192)
                if trailer in {b"\r\n", b"\n", b""}:
                    break
            break
        chunk = handler.rfile.read(size)
        handler.rfile.read(2)
        total += len(chunk)
        if total <= max_body_bytes:
            chunks.append(chunk)
        else:
            too_large = True
    return b"".join(chunks), too_large


def log_request_too_large(handler, content_length, body_source):
    log("request_rejected", {
        "path": handler.path,
        "reason": "request_body_too_large",
        "contentLength": content_length,
        "bodySource": body_source,
        "maxBodyBytes": CONFIG["max_body_bytes"],
        "contentType": handler.headers.get("Content-Type", "")[:120],
        "transferEncoding": handler.headers.get("Transfer-Encoding", "")[:80],
    })


def discard_body(handler, content_length):
    remaining = content_length
    while remaining > 0:
        chunk = handler.rfile.read(min(1024 * 1024, remaining))
        if not chunk:
            break
        remaining -= len(chunk)


def parse_multipart(body, content_type):
    environ = {"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type, "CONTENT_LENGTH": str(len(body))}
    form = cgi.FieldStorage(fp=io.BytesIO(body), environ=environ, keep_blank_values=True)
    fields = {}
    images = []
    for key in form.keys():
        item = form[key]
        items = item if isinstance(item, list) else [item]
        for part in items:
            filename = getattr(part, "filename", None)
            part_type = getattr(part, "type", "") or ""
            if filename or part_type.startswith("image/") or image_field_name(key):
                data = part.file.read()
                if data:
                    images.append(input_buffer_to_data_url(data, part_type or "image/png", f"multipart:{key}"))
            else:
                append_field(fields, key, part.value)
    images.extend(image_inputs_from_fields(fields))
    return {"fields": fields, "images": images[:collected_image_limit()], "meta": {"content_type": content_type}}


def generate_one(incoming, inbound_authorization):
    api_key = CONFIG["upstream_api_key"] or bearer_token(inbound_authorization)
    if not api_key:
        raise HttpError(401, "missing_lk888_api_key")
    model = request_model_from_fields(incoming["fields"])
    if is_banana_model(model):
        return generate_banana_image(incoming, api_key, model)
    return generate_gpt_image(incoming, api_key, model)


def generate_gpt_image(incoming, api_key, public_model):
    size_info = size_params_from_fields(incoming["fields"])
    params = {"size": size_info["size"]}
    images = incoming["images"][:CONFIG["max_input_images"]]
    if images:
        params["images"] = images
    if CONFIG["forward_quality"] and incoming["fields"].get("quality"):
        params["quality"] = str(incoming["fields"]["quality"])
    prompt = prompt_from_fields(incoming["fields"])
    if not prompt.strip():
        log("missing_prompt_detail", {
            "contentType": incoming.get("meta", {}).get("content_type", ""),
            "fieldKeys": sorted([str(key) for key in incoming["fields"].keys()])[:50],
            "fieldShape": field_shape(incoming["fields"]),
        })
        raise HttpError(400, "missing_prompt")
    upstream_model = CONFIG["upstream_model"]
    body = {"model": upstream_model, "prompt": prompt, "params": params}
    used_size = size_info["size"]
    log("upstream_request_prepared", {
        "public_model": public_model,
        "upstream_model": upstream_model,
        "params": params_for_log(params),
        "requested_size": size_info.get("requested_size"),
        "image_size": size_info["image_size"],
        "aspect_ratio": size_info["aspect_ratio"],
        "aspect_source": size_info.get("aspect_source"),
        "image_count": len(images),
    })
    try:
        raw = post_json(f'{CONFIG["upstream_base_url"]}/v1/media/generate', body, api_key)
    except HttpError as exc:
        if size_info["fallback_size"] != used_size and looks_like_size_error(exc.message):
            body["params"]["size"] = size_info["fallback_size"]
            used_size = size_info["fallback_size"]
            log("upstream_size_retry", {"from": size_info["size"], "to": used_size, "reason": exc.message})
            raw = post_json(f'{CONFIG["upstream_base_url"]}/v1/media/generate', body, api_key)
        else:
            raise
    raw_error = lk888_raw_error(raw)
    if raw_error and size_info["fallback_size"] != used_size and looks_like_size_error(raw_error):
        body["params"]["size"] = size_info["fallback_size"]
        used_size = size_info["fallback_size"]
        raw = post_json(f'{CONFIG["upstream_base_url"]}/v1/media/generate', body, api_key)
    immediate = safe_extract_images(raw)
    if immediate:
        return {"images": immediate, "meta": {"status": "immediate", "public_model": public_model, "upstream_model": upstream_model, "size": used_size, "image_size": size_info["image_size"], "aspect_ratio": size_info["aspect_ratio"]}}
    task_id = extract_task_id(raw)
    if not task_id:
        raise HttpError(502, lk888_raw_error(raw) or "LK888 did not return image or task_id")
    final_payload = poll_task(task_id, api_key)
    return {"images": extract_images(final_payload), "meta": {"status": "completed", "task_id": task_id, "public_model": public_model, "upstream_model": upstream_model, "size": used_size, "image_size": size_info["image_size"], "aspect_ratio": size_info["aspect_ratio"]}}


def generate_banana_image(incoming, api_key, public_model):
    params = banana_params_from_fields(incoming["fields"])
    images = incoming["images"][:CONFIG["max_banana_input_images"]]
    if images:
        params["images"] = images
    prompt = prompt_from_fields(incoming["fields"])
    if not prompt.strip():
        log("missing_prompt_detail", {
            "contentType": incoming.get("meta", {}).get("content_type", ""),
            "fieldKeys": sorted([str(key) for key in incoming["fields"].keys()])[:50],
            "fieldShape": field_shape(incoming["fields"]),
        })
        raise HttpError(400, "missing_prompt")
    upstream_model = CONFIG["banana_upstream_model"]
    body = {"model": upstream_model, "prompt": prompt, "params": params}
    raw = post_json(f'{CONFIG["upstream_base_url"]}/v1/media/generate', body, api_key)
    immediate = safe_extract_images(raw)
    if immediate:
        return {"images": immediate, "meta": {"status": "immediate", "public_model": public_model, "upstream_model": upstream_model, "image_size": params.get("imageSize"), "aspect_ratio": params.get("aspectRatio")}}
    task_id = extract_task_id(raw)
    if not task_id:
        raise HttpError(502, lk888_raw_error(raw) or "LK888 did not return image or task_id")
    final_payload = poll_task(task_id, api_key)
    return {"images": extract_images(final_payload), "meta": {"status": "completed", "task_id": task_id, "public_model": public_model, "upstream_model": upstream_model, "image_size": params.get("imageSize"), "aspect_ratio": params.get("aspectRatio")}}


def request_model_from_fields(fields):
    model = deep_field(fields, "model")
    return str(model or CONFIG["upstream_model"]).strip()


def is_banana_model(model):
    normalized = str(model or "").strip().lower().replace("_", "-")
    return normalized in {"nano-banana2", "nano-banana-2", "banana-2", "gemini-2.5-flash-image"}


def banana_params_from_fields(fields):
    params = {
        "aspectRatio": aspect_ratio_value(fields),
        "imageSize": image_size_label(fields),
    }
    thinking = deep_field(fields, "thinkingLevel") or deep_field(fields, "thinking_level")
    if thinking:
        params["thinkingLevel"] = str(thinking)
    web_search = deep_field(fields, "web_search")
    if web_search is None:
        web_search = deep_field(fields, "webSearch")
    if isinstance(web_search, bool):
        params["web_search"] = web_search
    elif isinstance(web_search, str) and web_search.strip().lower() in {"1", "true", "yes", "on"}:
        params["web_search"] = True
    return params


def poll_task(task_id, api_key):
    deadline = time.monotonic() + CONFIG["poll_timeout"]
    last_payload = None
    first = True
    while time.monotonic() < deadline:
        time.sleep(0.8 if first else CONFIG["poll_interval"])
        first = False
        url = f'{CONFIG["upstream_base_url"]}/v1/media/status?task_id={urllib.parse.quote(str(task_id))}'
        last_payload = get_json(url, api_key)
        if safe_extract_images(last_payload):
            return last_payload
        status = normalized_task_status(last_payload)
        if status in SUCCESS_STATUSES:
            return last_payload
        if status in FAILED_STATUSES:
            raise HttpError(502, task_fail_reason(last_payload))
    raise HttpError(504, f"LK888 task timeout, task_id={task_id}, last={safe_json(last_payload, 800)}")


def size_params_from_fields(fields):
    direct_size = nested_value(fields, ["params", "size"]) or fields.get("size") or fields.get("output_size")
    image_size = gpt_image_size_label(fields, direct_size)
    aspect_ratio, aspect_source = gpt_aspect_ratio_for_request(fields, direct_size)
    if aspect_ratio in GPT_SUPPORTED_ASPECT_RATIOS:
        size = exact_image_size(aspect_ratio, image_size)
    else:
        size = image_size
    return {
        "size": size,
        "fallback_size": image_size,
        "image_size": image_size,
        "aspect_ratio": aspect_ratio,
        "aspect_source": aspect_source,
        "requested_size": str(direct_size or "").strip(),
    }


def gpt_image_size_label(fields, direct_size=None):
    for value in [
        deep_field(fields, "image_size"),
        deep_field(fields, "imageSize"),
        deep_field(fields, "resolution"),
        deep_field(fields, "quality_size"),
        direct_size,
        deep_field(fields, "size"),
    ]:
        label = normalize_gpt_image_size_label(value)
        if label:
            return label
    return "2K"


def normalize_gpt_image_size_label(value):
    text = str(value or "").strip().upper().replace("×", "X").replace("*", "X")
    compact = re.sub(r"\s+", "", text)
    if compact in GPT_IMAGE_SIZE_LABELS:
        return compact
    if compact == "4K":
        return "2K"
    match = re.match(r"^(\d{2,5})X(\d{2,5})$", compact)
    if match:
        long_edge = max(int(match.group(1)), int(match.group(2)))
        return "2K" if long_edge > 1280 else "1K"
    return ""


def gpt_aspect_ratio_for_request(fields, direct_size=None):
    explicit = normalize_aspect_ratio(deep_field(fields, "aspect_ratio") or deep_field(fields, "aspectRatio") or deep_field(fields, "ratio"))
    if explicit:
        if explicit in GPT_SUPPORTED_ASPECT_RATIOS:
            return explicit, "field"
        coerced = closest_supported_aspect_ratio(explicit)
        return (coerced, f"coerced:{explicit}->{coerced}") if coerced else ("", f"unsupported:{explicit}")
    derived = aspect_ratio_from_pixel_size(direct_size)
    if derived:
        return derived, "size"
    return "1:1", "default"


def normalize_aspect_ratio(value):
    text = str(value or "").strip().replace("：", ":").replace("/", ":")
    if not text:
        return ""
    try:
        w, h = [float(part) for part in text.split(":", 1)]
        if w > 0 and h > 0:
            if abs(w - int(w)) < 0.001 and abs(h - int(h)) < 0.001:
                return f"{int(w)}:{int(h)}"
            return f"{w:g}:{h:g}"
    except Exception:
        pass
    return text


def aspect_ratio_number(value):
    try:
        w, h = [float(part) for part in str(value or "").split(":", 1)]
        if w > 0 and h > 0:
            return w / h
    except Exception:
        pass
    return None


def closest_supported_aspect_ratio(value):
    target = aspect_ratio_number(value)
    if not target:
        return ""
    return min(GPT_SUPPORTED_ASPECT_RATIOS, key=lambda item: abs((aspect_ratio_number(item) or 1.0) - target))


def aspect_ratio_from_pixel_size(value):
    text = str(value or "").strip().replace("×", "x").replace("*", "x")
    match = re.match(r"^\s*(\d{2,5})\s*x\s*(\d{2,5})\s*$", text, re.I)
    if not match:
        return ""
    width, height = int(match.group(1)), int(match.group(2))
    if width <= 0 or height <= 0:
        return ""
    ratio = width / height
    best = min(GPT_SUPPORTED_ASPECT_RATIOS, key=lambda item: abs((aspect_ratio_number(item) or 1.0) - ratio))
    best_ratio = aspect_ratio_number(best) or 1.0
    return best if abs(best_ratio - ratio) <= 0.04 else ""


def params_for_log(params):
    safe = {}
    for key, value in params.items():
        if key == "images" and isinstance(value, list):
            safe[key] = f"<{len(value)} images>"
        else:
            safe[key] = value
    return safe


def prompt_from_fields(fields):
    if not isinstance(fields, dict):
        return ""
    for key in ["prompt", "input", "text", "message", "content", "description"]:
        text = text_from_prompt_value(deep_field(fields, key))
        if text:
            return text
    text = messages_prompt(deep_field(fields, "messages"))
    if text:
        return text
    for container in ["params", "body", "payload", "request", "data"]:
        value = fields.get(container)
        if isinstance(value, dict):
            text = prompt_from_fields(value)
            if text:
                return text
    return ""


def deep_field(fields, key):
    if not isinstance(fields, dict):
        return None
    if key in fields:
        return fields.get(key)
    for container in ["params", "body", "payload", "request", "data"]:
        value = fields.get(container)
        if isinstance(value, dict) and key in value:
            return value.get(key)
    return None


def messages_prompt(messages):
    if isinstance(messages, dict):
        messages = messages.get("messages") or messages.get("data") or messages.get("items") or messages.get("content")
    if not isinstance(messages, list):
        return text_from_prompt_value(messages)
    parts = []
    for message in messages:
        if isinstance(message, dict):
            role = str(message.get("role") or "").strip().lower()
            if role and role not in {"user", "human"}:
                continue
            text = text_from_prompt_value(message.get("content") or message.get("text") or message.get("prompt"))
        else:
            text = text_from_prompt_value(message)
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def text_from_prompt_value(value):
    if value is None:
        return ""
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("data:image/") or looks_like_image_url(text):
            return ""
        return text
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, list):
        return "\n".join([item for item in [text_from_prompt_value(item) for item in value] if item]).strip()
    if not isinstance(value, dict):
        return ""
    kind = str(value.get("type") or "").lower()
    if "image" in kind and not any(key in value for key in ["text", "prompt", "content", "message"]):
        return ""
    for key in ["prompt", "text", "content", "message", "value"]:
        text = text_from_prompt_value(value.get(key))
        if text:
            return text
    return ""


def exact_image_size(aspect_ratio, image_size):
    edge = {"1K": 1024, "2K": 2304, "4K": 4096}.get(normalize_image_size_label(image_size), 2304)
    w, h = aspect_ratio_parts(aspect_ratio)
    if abs(w - h) < 0.01:
        return f"{edge}x{edge}"
    if w > h:
        return f"{edge}x{max(1, round(edge * h / w))}"
    return f"{max(1, round(edge * w / h))}x{edge}"


def aspect_ratio_parts(aspect_ratio):
    match = re.match(r"^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$", str(aspect_ratio or "1:1").strip())
    if not match:
        return 1.0, 1.0
    w, h = float(match.group(1)), float(match.group(2))
    return (w, h) if w > 0 and h > 0 else (1.0, 1.0)


def image_size_label(fields):
    return normalize_image_size_label(deep_field(fields, "image_size") or deep_field(fields, "imageSize") or deep_field(fields, "resolution") or deep_field(fields, "quality_size") or deep_field(fields, "size") or "2K")


def normalize_image_size_label(value):
    text = str(value or "").strip().upper()
    if text in {"1K", "2K", "4K"}:
        return text
    if text == "1024X1024":
        return "1K"
    if text in {"2048X2048", "2304X2304"}:
        return "2K"
    if text == "4096X4096":
        return "4K"
    return "2K"


def aspect_ratio_value(fields):
    return str(deep_field(fields, "aspect_ratio") or deep_field(fields, "aspectRatio") or deep_field(fields, "ratio") or "1:1").strip() or "1:1"


def image_inputs_from_fields(fields, limit=None):
    images = []
    for key in ["image", "images", "image_url", "image_urls", "imageUrl", "imageUrls", "reference_image", "reference_images"]:
        collect_image_values(images, deep_field(fields, key))
    prepared = []
    for index, item in enumerate(images):
        image = prepare_input_image_value(item, f"field:{index}")
        if image:
            prepared.append(image)
    return prepared[:(limit or collected_image_limit())]


def collected_image_limit():
    return max(CONFIG["max_input_images"], CONFIG["max_banana_input_images"])


def collect_image_values(out, value):
    if not value:
        return
    if isinstance(value, list):
        for item in value:
            collect_image_values(out, item)
    elif isinstance(value, str):
        text = value.strip()
        if text:
            out.append(text)
    elif isinstance(value, dict):
        collect_image_values(out, value.get("url") or value.get("image_url") or value.get("imageUrl") or value.get("b64_json") or value.get("base64"))


def extract_images(payload):
    found, seen = [], set()

    def add(kind, value, mime_type="image/png"):
        if not value:
            return
        marker = f"{kind}:{value}"
        if marker not in seen:
            seen.add(marker)
            found.append({"type": kind, "value": value, "mime_type": mime_type})

    def walk(value, depth=0, trusted_key=""):
        if depth > 8 or value is None:
            return
        if isinstance(value, str):
            if value.startswith("data:image/"):
                add("url", value)
            elif looks_like_image_url(value) or image_output_key(trusted_key):
                add("url", value)
            return
        if isinstance(value, list):
            for item in value:
                walk(item, depth + 1, trusted_key)
            return
        if not isinstance(value, dict):
            return
        for key in ["b64_json", "base64", "image_base64"]:
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                add("b64", strip_data_url(item.strip()), value.get("mime_type") or value.get("mimeType") or "image/png")
        for key, item in value.items():
            walk(item, depth + 1, key)

    walk(payload)
    if not found:
        raise HttpError(502, "no_image_in_lk888_response")
    return found


def safe_extract_images(payload):
    try:
        return extract_images(payload)
    except Exception:
        return []


def extract_task_id(payload):
    if not isinstance(payload, dict):
        return ""
    for key in ["task_id", "taskId", "task", "job_id", "jobId"]:
        if payload.get(key):
            return str(payload[key])
    task_ids = payload.get("任务ids") or payload.get("task_ids") or payload.get("taskIds")
    if isinstance(task_ids, list) and task_ids:
        return str(task_ids[0])
    if payload.get("id") and (str(payload["id"]).startswith("task") or payload.get("status") or payload.get("task_status") or payload.get("state")):
        return str(payload["id"])
    nested = payload.get("data")
    if isinstance(nested, list) and nested:
        return extract_task_id(nested[0])
    if isinstance(nested, dict):
        return extract_task_id(nested)
    return ""


def normalized_task_status(payload):
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict):
        return ""
    code = payload.get("code") if isinstance(payload, dict) else None
    if code not in (None, "", 0, 200, "0", "200"):
        return "FAILED"
    return str(data.get("status") or data.get("task_status") or data.get("state") or data.get("任务状态") or data.get("status_msg") or data.get("statusMsg") or data.get("状态") or "").strip().upper()


def task_fail_reason(payload):
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else payload
    error = data.get("error") if isinstance(data, dict) and isinstance(data.get("error"), dict) else {}
    return str(data.get("fail_reason") or data.get("失败原因") or data.get("error_msg") or data.get("message") or data.get("msg") or error.get("message") or "LK888 task failed")


def lk888_raw_error(payload):
    if not isinstance(payload, dict) or payload.get("code") in (None, "", 0, 200, "0", "200"):
        return ""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    return str(payload.get("message") or payload.get("msg") or data.get("message") or data.get("msg") or data.get("失败原因") or "")


def request_json(url, method, api_key, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {api_key}")
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=CONFIG["request_timeout"]) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text) if text else {}
        except Exception:
            payload = {}
        message = ""
        if isinstance(payload.get("error"), dict):
            message = payload["error"].get("message") or ""
        message = payload.get("message") or payload.get("msg") or message
        raise HttpError(502, str(message or text or f"LK888 HTTP {exc.code}")[:500])


def post_json(url, body, api_key):
    return request_json(url, "POST", api_key, body)


def get_json(url, api_key):
    return request_json(url, "GET", api_key)


def openai_image_response(images, upstream_meta):
    data = [{"b64_json": strip_data_url(image["value"])} if image["type"] == "b64" else {"url": image["value"]} for image in images]
    model = upstream_meta[-1].get("upstream_model") if upstream_meta else CONFIG["upstream_model"]
    return {"created": int(time.time()), "data": data, "upstream": {"adapter": "lk888-image", "model": model, "tasks": upstream_meta}}


def image_field_name(name):
    return str(name or "") in {"image", "images", "image[]", "file", "files"}


def image_output_key(key):
    return re.match(r"^(url|image|image_url|imageUrl|output|result|origin_image_url|originImageUrl)$", str(key or ""), re.I)


def looks_like_image_url(value):
    text = str(value or "").strip()
    if not re.match(r"^https?://", text, re.I):
        return False
    parsed = urllib.parse.urlparse(text)
    path = (parsed.path or "") + ("?" + parsed.query if parsed.query else "")
    return bool(re.search(r"\.(png|jpe?g|webp|gif|bmp|tiff)(?:$|\?)", path, re.I) or re.search(r"image|img|cdn|oss|cos|r2|s3|media|output|result", parsed.netloc + parsed.path, re.I))


def is_pixel_size(value):
    return bool(re.match(r"^\d{2,5}\s*x\s*\d{2,5}$", str(value or "").strip(), re.I))


def looks_like_size_error(text):
    value = str(text or "").lower()
    return "size" in value and any(item in value for item in ["invalid", "unsupported", "illegal", "不合法"])


def nested_value(data, keys):
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def prepare_input_image_value(value, source="field"):
    text = str(value or "").strip()
    if not text:
        return ""
    if text.startswith("http://") or text.startswith("https://"):
        return text
    data, content_type = decode_input_image_value(text)
    if not data:
        return text
    return input_buffer_to_data_url(data, content_type, source)


def decode_input_image_value(value):
    match = re.match(r"^data:(image/[a-z0-9.+-]+);base64,(.*)$", str(value or "").strip(), re.I | re.S)
    if match:
        content_type = match.group(1)
        payload = re.sub(r"\s+", "", match.group(2))
    else:
        content_type = "image/png"
        payload = re.sub(r"\s+", "", str(value or "").strip())
        if not looks_like_base64_image_payload(payload):
            return b"", content_type
    try:
        return base64.b64decode(payload, validate=False), content_type
    except Exception:
        return b"", content_type


def looks_like_base64_image_payload(payload):
    if len(payload) < 100 or not re.match(r"^[A-Za-z0-9+/=_-]+$", payload):
        return False
    return payload.startswith(("iVBOR", "/9j/", "UklGR", "R0lGOD", "Qk"))


def input_buffer_to_data_url(data, content_type, source="multipart"):
    prepared, prepared_type = fit_input_image_for_upstream(data, content_type, source)
    return buffer_to_data_url(prepared, prepared_type)


def fit_input_image_for_upstream(data, content_type, source="image"):
    content_type = normalize_image_content_type(content_type)
    max_bytes = CONFIG["max_upstream_image_bytes"]
    if not CONFIG["compress_input_images"] or len(data) <= max_bytes:
        return data, content_type
    if not PIL_AVAILABLE:
        log("input_image_compress_unavailable", {
            "source": source,
            "originalBytes": len(data),
            "maxBytes": max_bytes,
            "contentType": content_type,
        })
        raise HttpError(413, "input_image_too_large")
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        original_width, original_height = image.size
        working = image_to_rgb(image)
    except Exception as exc:
        log("input_image_compress_failed", {
            "source": source,
            "reason": str(exc)[:160],
            "originalBytes": len(data),
            "maxBytes": max_bytes,
            "contentType": content_type,
        })
        raise HttpError(413, "input_image_too_large")

    best_data = b""
    best_meta = {}
    qualities = [90, 86, 82, 78, 74, 70, 66, 62, 58, 54, 50]
    for step in range(10):
        for quality in qualities:
            output = io.BytesIO()
            working.save(output, format="JPEG", quality=quality, optimize=True, progressive=True)
            candidate = output.getvalue()
            if not best_data or len(candidate) < len(best_data):
                best_data = candidate
                best_meta = {"quality": quality, "width": working.width, "height": working.height}
            if len(candidate) <= max_bytes:
                log("input_image_compressed", {
                    "source": source,
                    "originalBytes": len(data),
                    "outputBytes": len(candidate),
                    "maxBytes": max_bytes,
                    "contentType": content_type,
                    "outputContentType": "image/jpeg",
                    "originalWidth": original_width,
                    "originalHeight": original_height,
                    "outputWidth": working.width,
                    "outputHeight": working.height,
                    "quality": quality,
                })
                return candidate, "image/jpeg"
        ratio = min(0.86, max(0.55, (max_bytes / max(1, len(best_data))) ** 0.5 * 0.94))
        new_width = max(256, int(working.width * ratio))
        new_height = max(256, int(working.height * ratio))
        if (new_width, new_height) == working.size:
            break
        working = working.resize((new_width, new_height), resample_filter())

    log("input_image_compress_failed", {
        "source": source,
        "reason": "compressed_image_still_too_large",
        "originalBytes": len(data),
        "bestBytes": len(best_data),
        "maxBytes": max_bytes,
        "best": best_meta,
        "contentType": content_type,
    })
    raise HttpError(413, "input_image_too_large")


def image_to_rgb(image):
    if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")


def resample_filter():
    return getattr(getattr(Image, "Resampling", Image), "LANCZOS", 1)


def normalize_image_content_type(content_type):
    text = str(content_type or "").split(";", 1)[0].strip().lower()
    return text if text.startswith("image/") else "image/png"


def buffer_to_data_url(data, content_type):
    return f"data:{content_type or 'image/png'};base64,{base64.b64encode(data).decode('ascii')}"


def strip_data_url(value):
    return re.sub(r"^data:image/[a-z0-9.+-]+;base64,", "", str(value or ""), flags=re.I)


def append_field(fields, key, value):
    if key not in fields:
        fields[key] = value
    elif isinstance(fields[key], list):
        fields[key].append(value)
    else:
        fields[key] = [fields[key], value]


def bearer_token(value):
    match = re.match(r"^Bearer\s+(.+)$", str(value or ""), re.I)
    return match.group(1).strip() if match else ""


def clamp_int(value, minimum, maximum):
    try:
        parsed = int(value)
    except Exception:
        parsed = minimum
    return max(minimum, min(maximum, parsed))


def safe_json(value, limit=1000):
    try:
        return json.dumps(value, ensure_ascii=False)[:limit]
    except Exception:
        return ""


def field_shape(value, depth=0):
    if depth > 3:
        return "..."
    if isinstance(value, dict):
        shaped = {}
        for key in list(value.keys())[:30]:
            shaped[str(key)] = field_shape(value.get(key), depth + 1)
        return shaped
    if isinstance(value, list):
        return {"type": "list", "len": len(value), "sample": field_shape(value[0], depth + 1) if value else None}
    if isinstance(value, str):
        return {"type": "str", "len": len(value)}
    if value is None:
        return "null"
    return type(value).__name__


def log(event, data=None):
    payload = {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event}
    payload.update(data or {})
    text = json.dumps(payload, ensure_ascii=False)
    text = re.sub(r"Bearer\s+[A-Za-z0-9._-]+", "Bearer [REDACTED]", text)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()
    try:
        with open(CONFIG["log_file"], "a", encoding="utf-8") as file:
            file.write(text + "\n")
    except Exception:
        pass


def main():
    server = ThreadingHTTPServer((CONFIG["host"], CONFIG["port"]), Handler)
    log("server_started", {"host": CONFIG["host"], "port": CONFIG["port"], "upstreamBaseUrl": CONFIG["upstream_base_url"], "upstreamModel": CONFIG["upstream_model"]})
    server.serve_forever()


if __name__ == "__main__":
    main()
