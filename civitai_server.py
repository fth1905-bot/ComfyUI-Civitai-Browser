import asyncio
import io
import json
import logging
import os
import re
import time
import uuid
import zipfile
from urllib.parse import urlencode, urlparse, unquote

import aiohttp
from aiohttp import web

import folder_paths
from server import PromptServer

LOG = "[Civitai Browser]"
CIVITAI_API = "https://civitai.com/api/v1"
PREFIX = "/civitai_browser"
EXT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(EXT_DIR, "config.json")

MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx", ".pkl")
SKIP_FOLDERS = {"custom_nodes", "configs", "datasets", "classifiers"}
MAX_WORKFLOW_BYTES = 80 * 1024 * 1024

# Civitai model type -> ComfyUI model folder
TYPE_TO_FOLDER = {
    "checkpoint": "checkpoints",
    "lora": "loras",
    "locon": "loras",
    "dora": "loras",
    "lycoris": "loras",
    "textualinversion": "embeddings",
    "embedding": "embeddings",
    "vae": "vae",
    "controlnet": "controlnet",
    "upscaler": "upscale_models",
    "hypernetwork": "hypernetworks",
    "motionmodule": "animatediff_models",
    "detection": "ultralytics",
}

# loader node type (lowercase substring) -> ComfyUI model folder
NODE_TO_FOLDER = [
    ("checkpointloader", "checkpoints"),
    ("imageonlycheckpointloader", "checkpoints"),
    ("lora", "loras"),
    ("vaeloader", "vae"),
    ("controlnet", "controlnet"),
    ("upscalemodel", "upscale_models"),
    ("clipvision", "clip_vision"),
    ("clip", "text_encoders"),
    ("unet", "diffusion_models"),
    ("diffusionmodel", "diffusion_models"),
    ("stylemodel", "style_models"),
    ("gligen", "gligen"),
    ("hypernetwork", "hypernetworks"),
    ("photomaker", "photomaker"),
    ("ipadapter", "ipadapter"),
    ("instantid", "instantid"),
    ("animatediff", "animatediff_models"),
    ("ultralytics", "ultralytics"),
    ("samloader", "sams"),
    ("gguf", "diffusion_models"),
]


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _api_key(request=None):
    key = ""
    if request is not None:
        key = (request.headers.get("X-Civitai-Key") or "").strip()
    if not key:
        key = (os.environ.get("CIVITAI_API_KEY") or os.environ.get("CIVITAI_TOKEN") or "").strip()
    if not key:
        key = (_load_config().get("api_key") or "").strip()
    return key


def _session():
    return aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=None, connect=30, sock_read=120),
        trust_env=True,
        headers={"User-Agent": "ComfyUI-Civitai-Browser/1.0"},
    )


def _model_folders():
    return sorted(k for k in folder_paths.folder_names_and_paths.keys() if k not in SKIP_FOLDERS)


def _folder_dir(folder):
    """First registered path for a model folder (created if missing)."""
    if folder in folder_paths.folder_names_and_paths:
        paths = folder_paths.get_folder_paths(folder)
        target = paths[0]
    else:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+", folder or ""):
            raise ValueError("invalid folder name")
        target = os.path.join(folder_paths.models_dir, folder)
        folder_paths.add_model_folder_path(folder, target)
    os.makedirs(target, exist_ok=True)
    return target


def _safe_relpath(name):
    """Keep sub folders like 'sdxl/model.safetensors' but block path traversal."""
    name = (name or "").replace("\\", "/")
    parts = [p for p in name.split("/") if p not in ("", ".", "..")]
    parts = [re.sub(r'[<>:"|?*\x00-\x1f]', "_", p) for p in parts]
    return os.path.join(*parts) if parts else ""


def _local_index():
    """Set of every model file name ComfyUI can see (full relative + basename)."""
    names = set()
    for folder in _model_folders():
        try:
            for f in folder_paths.get_filename_list(folder):
                f2 = f.replace("\\", "/").lower()
                names.add(f2)
                names.add(f2.rsplit("/", 1)[-1])
        except Exception:
            pass
    return names


def _guess_folder(node_type, filename=""):
    nt = (node_type or "").lower()
    for key, folder in NODE_TO_FOLDER:
        if key in nt:
            return folder
    # a custom node that registered its own model folder (e.g. "SEEDVR2", "ipadapter")
    for folder in _model_folders():
        if len(folder) >= 4 and folder.lower() in nt:
            return folder
    fn = (filename or "").lower()
    if fn.endswith(".gguf") and "clip" not in fn and "t5" not in fn:
        return "diffusion_models"
    if "lora" in fn:
        return "loras"
    if "vae" in fn:
        return "vae"
    if "control" in fn:
        return "controlnet"
    if "upscale" in fn or re.search(r"\b\dx\b|esrgan", fn):
        return "upscale_models"
    return "checkpoints"


def _json_error(msg, status=400):
    return web.json_response({"error": msg}, status=status)


# --------------------------------------------------------------------------- #
# Civitai proxy
# --------------------------------------------------------------------------- #
ALLOWED_QUERY = {"limit", "cursor", "page", "query", "types", "sort", "period", "nsfw",
                 "baseModels", "username", "tag", "ids", "favorites"}


async def _civitai_get(path, params, request):
    key = _api_key(request)
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    url = f"{CIVITAI_API}{path}"
    async with _session() as s:
        async with s.get(url, params=params, headers=headers) as r:
            text = await r.text()
            try:
                data = json.loads(text)
            except Exception:
                data = {"error": text[:500]}
            return r.status, data


routes = PromptServer.instance.routes


@routes.get(PREFIX + "/models")
async def civitai_models(request):
    params = []
    for k, v in request.rel_url.query.items():
        if k in ALLOWED_QUERY and v != "":
            params.append((k, v))
    try:
        status, data = await _civitai_get("/models", params, request)
    except Exception as e:
        return _json_error(f"Could not reach Civitai: {e}", 502)
    return web.json_response(data, status=status)


@routes.get(PREFIX + "/model/{id}")
async def civitai_model(request):
    mid = request.match_info["id"]
    if not mid.isdigit():
        return _json_error("invalid id")
    try:
        status, data = await _civitai_get(f"/models/{mid}", None, request)
    except Exception as e:
        return _json_error(str(e), 502)
    return web.json_response(data, status=status)


@routes.get(PREFIX + "/folders")
async def list_folders(request):
    return web.json_response({"folders": _model_folders(), "type_map": TYPE_TO_FOLDER})


@routes.get(PREFIX + "/config")
async def get_config(request):
    return web.json_response({"has_server_key": bool(_api_key(None))})


# --------------------------------------------------------------------------- #
# downloads
# --------------------------------------------------------------------------- #
DOWNLOADS = {}  # id -> dict
DL_HISTORY_PATH = os.path.join(EXT_DIR, "downloads_history.json")


def _save_dl_history():
    try:
        done = [_public(t) for t in DOWNLOADS.values() if t["status"] not in ("downloading", "queued")]
        done.sort(key=lambda t: t["started_at"], reverse=True)
        with open(DL_HISTORY_PATH, "w", encoding="utf-8") as f:
            json.dump(done[:300], f, ensure_ascii=False)
    except Exception as e:
        logging.warning(f"{LOG} could not save download history: {e}")


def _load_dl_history():
    try:
        with open(DL_HISTORY_PATH, "r", encoding="utf-8") as f:
            for t in json.load(f):
                if isinstance(t, dict) and t.get("id"):
                    DOWNLOADS[t["id"]] = t
    except Exception:
        pass


def _public(task):
    return {k: v for k, v in task.items() if not k.startswith("_")}


def _with_token(url, key):
    host = (urlparse(url).hostname or "").lower()
    if key and host.endswith("civitai.com") and "token=" not in url:
        url += ("&" if "?" in url else "?") + urlencode({"token": key})
    return url


def _filename_from_response(resp, url):
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r"filename\*=UTF-8''([^;]+)", cd) or re.search(r'filename="?([^";]+)"?', cd)
    if m:
        return unquote(m.group(1)).strip()
    return unquote(os.path.basename(urlparse(str(resp.url)).path)) or "model.safetensors"


async def _run_download(task, key):
    url = _with_token(task["url"], key)
    tmp = None
    try:
        folder_dir = _folder_dir(task["folder"])
        async with _session() as s:
            async with s.get(url, allow_redirects=True) as r:
                if r.status == 401 or r.status == 403:
                    raise RuntimeError("Unauthorized (401/403). This file probably requires a Civitai API key.")
                if r.status >= 400:
                    raise RuntimeError(f"HTTP {r.status}")
                ctype = r.headers.get("Content-Type", "")
                if "text/html" in ctype:
                    raise RuntimeError("Got an HTML page instead of a file (login / API key may be required).")
                fname = task.get("filename") or _filename_from_response(r, url)
                rel = _safe_relpath(fname)
                if not rel:
                    raise RuntimeError("invalid file name")
                dest = os.path.abspath(os.path.join(folder_dir, rel))
                if not dest.startswith(os.path.abspath(folder_dir) + os.sep):
                    raise RuntimeError("invalid target path")
                task["filename"] = rel.replace("\\", "/")
                task["path"] = dest
                if os.path.exists(dest):
                    task["status"] = "exists"
                    task["progress"] = 1.0
                    return
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                total = int(r.headers.get("Content-Length") or 0)
                task["total"] = total
                tmp = dest + ".civitai_part"
                done = 0
                last = time.time()
                last_done = 0
                with open(tmp, "wb") as f:
                    async for chunk in r.content.iter_chunked(1024 * 1024):
                        if task.get("_cancel"):
                            raise asyncio.CancelledError()
                        f.write(chunk)
                        done += len(chunk)
                        task["downloaded"] = done
                        if total:
                            task["progress"] = done / total
                        now = time.time()
                        if now - last >= 1:
                            task["speed"] = (done - last_done) / (now - last)
                            last, last_done = now, done
                os.replace(tmp, dest)
                tmp = None
                task["status"] = "done"
                task["progress"] = 1.0
                task["created_by_us"] = True
                try:
                    task["size"] = os.path.getsize(dest)
                except Exception:
                    pass
                logging.info(f"{LOG} downloaded {dest}")
    except asyncio.CancelledError:
        task["status"] = "cancelled"
    except Exception as e:
        task["status"] = "error"
        task["error"] = str(e)
        logging.warning(f"{LOG} download failed: {e}")
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass
        task["finished_at"] = time.time()
        _save_dl_history()


@routes.post(PREFIX + "/download")
async def start_download(request):
    body = await request.json()
    url = (body.get("url") or "").strip()
    folder = (body.get("folder") or "").strip()
    if not url.startswith("https://") and not url.startswith("http://"):
        return _json_error("invalid url")
    if not folder:
        return _json_error("folder is required")
    filename = body.get("filename") or ""
    if filename and not filename.lower().endswith(MODEL_EXTS):
        filename = ""  # let the server decide
    # same file already queued/running?
    for t in DOWNLOADS.values():
        if t["url"] == url and t["folder"] == folder and t["status"] in ("queued", "downloading"):
            return web.json_response(_public(t))
    tid = uuid.uuid4().hex[:12]
    task = {
        "id": tid, "url": url, "folder": folder, "filename": filename,
        "name": body.get("name") or filename or url, "status": "downloading",
        "progress": 0.0, "downloaded": 0, "total": 0, "speed": 0,
        "error": None, "started_at": time.time(), "finished_at": None,
        "workflow_file": os.path.basename(body.get("workflow_file") or "") or None,
    }
    DOWNLOADS[tid] = task
    task["_task"] = asyncio.create_task(_run_download(task, _api_key(request)))
    return web.json_response(_public(task))


@routes.get(PREFIX + "/downloads")
async def list_downloads(request):
    items = sorted(DOWNLOADS.values(), key=lambda t: t["started_at"], reverse=True)
    return web.json_response({"downloads": [_public(t) for t in items]})


@routes.post(PREFIX + "/downloads/{id}/cancel")
async def cancel_download(request):
    t = DOWNLOADS.get(request.match_info["id"])
    if not t:
        return _json_error("not found", 404)
    t["_cancel"] = True
    return web.json_response(_public(t))


@routes.post(PREFIX + "/downloads/clear")
async def clear_downloads(request):
    for tid in [k for k, t in DOWNLOADS.items() if t["status"] not in ("downloading", "queued")]:
        DOWNLOADS.pop(tid, None)
    _save_dl_history()
    return web.json_response({"ok": True})


# --------------------------------------------------------------------------- #
# workflow fetch (zip / json / png)
# --------------------------------------------------------------------------- #
def _png_workflow(data):
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        info = img.info or {}
        for k in ("workflow", "prompt"):
            if k in info:
                return json.loads(info[k])
    except Exception:
        pass
    return None


def _looks_like_workflow(obj):
    if not isinstance(obj, dict):
        return False
    if "nodes" in obj and isinstance(obj["nodes"], list):
        return True
    # API format: {"1": {"class_type": ..., "inputs": {...}}}
    vals = list(obj.values())
    return bool(vals) and all(isinstance(v, dict) and "class_type" in v for v in vals)


def _extract_workflows(data, name):
    out = []
    lname = (name or "").lower()
    if data[:4] == b"PK\x03\x04" or lname.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if info.is_dir() or info.file_size > MAX_WORKFLOW_BYTES:
                    continue
                n = info.filename
                ln = n.lower()
                if "__macosx" in ln:
                    continue
                try:
                    raw = z.read(info)
                except Exception:
                    continue
                if ln.endswith(".json"):
                    try:
                        obj = json.loads(raw.decode("utf-8-sig"))
                    except Exception:
                        continue
                    if _looks_like_workflow(obj):
                        out.append({"name": os.path.basename(n), "workflow": obj})
                elif ln.endswith(".png"):
                    obj = _png_workflow(raw)
                    if _looks_like_workflow(obj):
                        out.append({"name": os.path.basename(n), "workflow": obj})
        return out
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        obj = _png_workflow(data)
        if _looks_like_workflow(obj):
            out.append({"name": name, "workflow": obj})
        return out
    try:
        obj = json.loads(data.decode("utf-8-sig"))
        if _looks_like_workflow(obj):
            out.append({"name": name, "workflow": obj})
    except Exception:
        pass
    return out


@routes.post(PREFIX + "/workflow/fetch")
async def fetch_workflow(request):
    body = await request.json()
    url = (body.get("url") or "").strip()
    host = (urlparse(url).hostname or "").lower()
    if not url.startswith("https://") or not host.endswith("civitai.com"):
        return _json_error("only civitai.com links are supported")
    key = _api_key(request)
    try:
        async with _session() as s:
            async with s.get(_with_token(url, key), allow_redirects=True) as r:
                if r.status >= 400:
                    msg = f"HTTP {r.status}"
                    if r.status in (401, 403):
                        msg += " — a Civitai API key may be required (Settings > Civitai)."
                    return _json_error(msg, 502)
                fname = _filename_from_response(r, url)
                buf = bytearray()
                async for chunk in r.content.iter_chunked(256 * 1024):
                    buf.extend(chunk)
                    if len(buf) > MAX_WORKFLOW_BYTES:
                        return _json_error("file is too large", 413)
    except Exception as e:
        return _json_error(f"download failed: {e}", 502)
    try:
        wfs = _extract_workflows(bytes(buf), fname)
    except Exception as e:
        return _json_error(f"could not read file: {e}")
    if not wfs:
        return _json_error("No ComfyUI workflow found in this file.", 404)
    meta = {
        "model_id": body.get("model_id"), "version_id": body.get("version_id"),
        "model_name": body.get("name") or fname, "image": body.get("image"),
        "base_model": body.get("base_model"), "saved_at": time.time(),
    }
    for w in wfs:
        try:
            title = meta["model_name"] if len(wfs) == 1 else f'{meta["model_name"]} - {os.path.splitext(w["name"])[0]}'
            w["saved_as"] = _save_library_workflow(title, w["workflow"], meta)
        except Exception as e:
            logging.warning(f"{LOG} could not save workflow: {e}")
    return web.json_response({"file": fname, "workflows": wfs})


# --------------------------------------------------------------------------- #
# library: workflows saved into ComfyUI/user/default/workflows/Civitai
# --------------------------------------------------------------------------- #
LIB_SUBDIR = "Civitai"
LIB_META_PATH = os.path.join(EXT_DIR, "library.json")


def _lib_dir():
    d = os.path.join(folder_paths.get_user_directory(), "default", "workflows", LIB_SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def _lib_meta():
    try:
        with open(LIB_META_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _safe_title(t):
    t = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", t or "workflow").strip(" .")
    return (t or "workflow")[:120]


def _save_library_workflow(title, wf, meta):
    fname = _safe_title(title) + ".json"
    path = os.path.join(_lib_dir(), fname)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(wf, f, ensure_ascii=False, indent=2)
    allm = _lib_meta()
    allm[fname] = meta
    with open(LIB_META_PATH, "w", encoding="utf-8") as f:
        json.dump(allm, f, ensure_ascii=False)
    return f"{LIB_SUBDIR}/{fname}"


@routes.get(PREFIX + "/library")
async def library_list(request):
    d = _lib_dir()
    meta = _lib_meta()
    items = []
    for fn in os.listdir(d):
        if not fn.lower().endswith(".json"):
            continue
        p = os.path.join(d, fn)
        m = meta.get(fn) or {}
        items.append({
            "file": fn, "path": f"{LIB_SUBDIR}/{fn}", "title": os.path.splitext(fn)[0],
            "mtime": os.path.getmtime(p), "image": m.get("image"),
            "model_id": m.get("model_id"), "version_id": m.get("version_id"), "base_model": m.get("base_model"),
        })
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return web.json_response({"items": items, "folder": d})


@routes.get(PREFIX + "/library/file")
async def library_file(request):
    fn = os.path.basename(request.rel_url.query.get("file", ""))
    p = os.path.join(_lib_dir(), fn)
    if not fn.lower().endswith(".json") or not os.path.isfile(p):
        return _json_error("not found", 404)
    with open(p, "r", encoding="utf-8") as f:
        return web.json_response({"file": fn, "path": f"{LIB_SUBDIR}/{fn}", "workflow": json.load(f)})


def _wf_model_basenames(wf):
    names = set()
    try:
        for _, values, _ in _iter_nodes(wf):
            for n in _model_strings(values):
                names.add(n.replace("\\", "/").rsplit("/", 1)[-1].lower())
    except Exception:
        pass
    return names


def _model_roots():
    roots = []
    for folder in _model_folders():
        try:
            roots += [os.path.abspath(p) for p in folder_paths.get_folder_paths(folder)]
        except Exception:
            pass
    return roots


def _other_workflow_users(exclude_path):
    """basename -> [workflow names] for every saved user workflow except the one being deleted."""
    users = {}
    wf_root = os.path.join(folder_paths.get_user_directory(), "default", "workflows")
    ex = os.path.abspath(exclude_path)
    for dirpath, _, files in os.walk(wf_root):
        for fn in files:
            if not fn.lower().endswith(".json"):
                continue
            p = os.path.abspath(os.path.join(dirpath, fn))
            if p == ex:
                continue
            try:
                if os.path.getsize(p) > 20 * 1024 * 1024:
                    continue
                with open(p, "r", encoding="utf-8") as f:
                    wf = json.load(f)
            except Exception:
                continue
            rel = os.path.relpath(p, wf_root).replace("\\", "/")
            for b in _wf_model_basenames(wf):
                users.setdefault(b, []).append(rel)
    return users


def _deletable_models(lib_file):
    """Models this extension downloaded (and created) for the given library workflow.
    Pre-existing / user models are never included."""
    p = os.path.join(_lib_dir(), lib_file)
    try:
        with open(p, "r", encoding="utf-8") as f:
            wf_names = _wf_model_basenames(json.load(f))
    except Exception:
        wf_names = set()
    users = _other_workflow_users(p)
    roots = _model_roots()
    out, seen = [], set()
    for t in DOWNLOADS.values():
        if t.get("status") != "done" or not t.get("created_by_us") or not t.get("path"):
            continue
        path = os.path.abspath(t["path"])
        base = os.path.basename(path).lower()
        linked = t.get("workflow_file") == lib_file
        if not linked:
            # downloaded with this extension but not tagged (older version): only suggest if the workflow uses it
            if t.get("workflow_file") or base not in wf_names:
                continue
        if path in seen or not os.path.isfile(path):
            continue
        if not any(path.startswith(r + os.sep) for r in roots):
            continue
        if t.get("size") is not None and os.path.getsize(path) != t["size"]:
            continue  # file was replaced/changed since we downloaded it -> not ours anymore
        seen.add(path)
        out.append({
            "id": t["id"], "filename": t.get("filename") or base, "folder": t.get("folder"),
            "size": os.path.getsize(path), "linked": linked,
            "used_by": users.get(base, [])[:5],
        })
    return out


@routes.get(PREFIX + "/library/models")
async def library_models(request):
    fn = os.path.basename(request.rel_url.query.get("file", ""))
    if not fn.lower().endswith(".json") or not os.path.isfile(os.path.join(_lib_dir(), fn)):
        return _json_error("not found", 404)
    return web.json_response({"models": _deletable_models(fn)})


@routes.post(PREFIX + "/library/delete")
async def library_delete(request):
    body = await request.json()
    fn = os.path.basename(body.get("file") or "")
    d = _lib_dir()
    p = os.path.join(d, fn)
    if not fn.lower().endswith(".json") or not os.path.isfile(p):
        return _json_error("not found", 404)
    wanted = set(body.get("delete_models") or [])
    deleted, skipped = [], []
    if wanted:
        allowed = {m["id"]: m for m in _deletable_models(fn)}  # re-validated server side
        for tid in wanted:
            m = allowed.get(tid)
            if not m:
                skipped.append({"id": tid, "reason": "not downloaded by this extension, or modified since"})
                continue
            if m["used_by"]:
                skipped.append({"id": tid, "filename": m["filename"], "reason": "used by another workflow"})
                continue
            t = DOWNLOADS[tid]
            try:
                os.remove(t["path"])
                t["status"] = "deleted"
                deleted.append(m["filename"])
                logging.info(f"{LOG} removed model {t['path']}")
            except Exception as e:
                skipped.append({"id": tid, "filename": m["filename"], "reason": str(e)})
        _save_dl_history()
    os.remove(p)
    allm = _lib_meta()
    if allm.pop(fn, None) is not None:
        with open(LIB_META_PATH, "w", encoding="utf-8") as f:
            json.dump(allm, f, ensure_ascii=False)
    logging.info(f"{LOG} removed library workflow {fn}")
    return web.json_response({"ok": True, "deleted_models": deleted, "skipped": skipped})


# --------------------------------------------------------------------------- #
# analyze workflow -> missing models
# --------------------------------------------------------------------------- #
def _iter_nodes(wf):
    """Yields (node_type, values, properties) for UI and API format workflows."""
    if isinstance(wf, dict) and isinstance(wf.get("nodes"), list):
        graphs = [wf]
        for sg in ((wf.get("definitions") or {}).get("subgraphs") or []):
            graphs.append(sg)
        for g in graphs:
            for n in g.get("nodes") or []:
                vals = n.get("widgets_values")
                if isinstance(vals, dict):
                    vals = list(vals.values())
                yield n.get("type") or "", vals or [], n.get("properties") or {}
    elif isinstance(wf, dict):
        for n in wf.values():
            if isinstance(n, dict) and "class_type" in n:
                yield n["class_type"], list((n.get("inputs") or {}).values()), {}


def _model_strings(values):
    for v in values:
        if isinstance(v, str) and v.lower().endswith(MODEL_EXTS):
            yield v
        elif isinstance(v, dict):  # e.g. Power Lora Loader {"lora": "x.safetensors", ...}
            for vv in v.values():
                if isinstance(vv, str) and vv.lower().endswith(MODEL_EXTS):
                    yield vv


# --------------------------------------------------------------------------- #
# "use what I already have": find local files that look like the missing one
# --------------------------------------------------------------------------- #
_NOISE_TOKENS = {
    "fp16", "fp32", "fp8", "bf16", "fp8e4m3fn", "fp8e5m2", "e4m3fn", "e5m2", "scaled", "pruned", "full",
    "ema", "noema", "nonema", "emaonly", "safetensors", "ckpt", "final", "model", "fixed", "inpainting",
}


def _name_tokens(name):
    stem = os.path.splitext(name.replace("\\", "/").rsplit("/", 1)[-1].lower())[0]
    toks = [t for t in re.split(r"[^a-z0-9]+", stem) if t]
    core = []
    for t in toks:
        if t in _NOISE_TOKENS or re.fullmatch(r"v?\d+(p\d+)?|q\d+|k|[sml]|\d+b", t):
            continue  # versions, quantization (q4_k_m), sizes (7b)
        # juggernautxl9 -> juggernautxl ; realvisxlv50 -> realvisxl
        for part in re.split(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", t):
            part = re.sub(r"v$", "", part) if len(part) > 3 else part
            if part and not part.isdigit() and part not in _NOISE_TOKENS:
                core.append(part)
    return stem, toks, core


def _ext_group(name):
    e = os.path.splitext(name.lower())[1]
    return "gguf" if e == ".gguf" else ("onnx" if e == ".onnx" else "torch")


def _similar_local(missing_name, folder, limit=3):
    from difflib import SequenceMatcher
    _, m_toks, m_core = _name_tokens(missing_name)
    if not m_core:
        return []
    m_core_s = " ".join(m_core)
    m_group = _ext_group(missing_name)
    pools = [folder] + [f for f in _model_folders() if f != folder]
    out, seen = [], set()
    for i, fold in enumerate(pools):
        try:
            names = folder_paths.get_filename_list(fold)
        except Exception:
            continue
        for n in names:
            if _ext_group(n) != m_group:
                continue
            _, toks, core = _name_tokens(n)
            if not core:
                continue
            core_s = " ".join(core)
            overlap = len(set(core) & set(m_core)) / max(len(set(core) | set(m_core)), 1)
            ratio = SequenceMatcher(None, core_s, m_core_s).ratio()
            score = max(overlap, ratio)
            if core_s == m_core_s:
                score = 1.0
            elif min(len(core_s), len(m_core_s)) < 5:
                continue  # very short names (e.g. "ae" vs "vae") are too ambiguous for fuzzy matching
            if score < 0.72:
                continue
            if i > 0:
                score -= 0.1  # prefer the folder the workflow's loader reads from
            key = (fold, n)
            if key in seen:
                continue
            seen.add(key)
            out.append({"name": n, "folder": fold, "score": round(score, 3), "same_folder": i == 0})
    out.sort(key=lambda x: -x["score"])
    return out[:limit]


@routes.post(PREFIX + "/analyze")
async def analyze_workflow(request):
    body = await request.json()
    wf = body.get("workflow")
    if not isinstance(wf, dict):
        return _json_error("workflow is required")
    local = _local_index()
    known_urls = {}
    for _, _, props in _iter_nodes(wf):
        for m in props.get("models") or []:
            if isinstance(m, dict) and m.get("name"):
                known_urls[m["name"].replace("\\", "/").rsplit("/", 1)[-1].lower()] = m
    for m in (wf.get("models") or []) if isinstance(wf.get("models"), list) else []:
        if isinstance(m, dict) and m.get("name"):
            known_urls[m["name"].replace("\\", "/").rsplit("/", 1)[-1].lower()] = m

    missing, present, seen = [], [], set()
    for node_type, values, _ in _iter_nodes(wf):
        for name in _model_strings(values):
            norm = name.replace("\\", "/")
            base = norm.rsplit("/", 1)[-1]
            key = base.lower()
            if key in seen:
                continue
            seen.add(key)
            if norm.lower() in local or key in local:
                present.append({"name": norm, "node_type": node_type})
                continue
            info = known_urls.get(key) or {}
            folder = info.get("directory") or _guess_folder(node_type, base)
            try:
                similar = _similar_local(base, folder)
            except Exception as e:
                logging.warning(f"{LOG} similar-file lookup failed: {e}")
                similar = []
            missing.append({
                "name": norm, "basename": base, "node_type": node_type,
                "folder": folder, "url": info.get("url"), "similar": similar,
            })
    return web.json_response({"missing": missing, "present": present, "folders": _model_folders()})


_load_dl_history()
logging.info(f"{LOG} routes registered at {PREFIX}/*")
