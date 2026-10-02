"""
ComfyUI Civitai Browser
-----------------------
Adds a "Civitai" section to the ComfyUI sidebar (like Templates) where you can
browse Civitai workflows and models and make a workflow ready with one click
(load it, detect missing models, download them into the right folders).

This extension does not add or override any nodes and never touches ComfyUI's
core files. If anything goes wrong while loading, it only logs a warning so
ComfyUI keeps starting normally.
"""
import logging

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

try:
    from . import civitai_server  # noqa: F401  (registers the HTTP routes)
except Exception as e:  # never break ComfyUI startup
    logging.warning(f"[Civitai Browser] backend could not be loaded: {e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
