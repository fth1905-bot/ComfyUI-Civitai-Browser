# Changelog

## 1.1.0
- **My Library**: every downloaded workflow is saved to `user/default/workflows/Civitai/` and can be reopened later
- **Safe delete**: remove a workflow together with the models that were downloaded for it. User-owned, modified and shared models are always protected, and the checks are re-validated on the server.
- Download history is kept across restarts
- Fixed: the browser could stay empty after quickly switching categories
- UI and messages translated to English

## 1.0.0
- Civitai sidebar tab and full-screen browser (workflows, checkpoints, LoRA, embeddings, ControlNet, VAE, upscalers, motion modules)
- One-click **Load & Set Up**: load a workflow, detect missing models, find them on Civitai and download them under the expected file names
- Missing custom node detection
- Background model downloads into the matching ComfyUI folders, plus **Add to canvas**
- Civitai API key and NSFW settings
