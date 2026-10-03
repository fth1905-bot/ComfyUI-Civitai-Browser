# Changelog

## 1.4.0
- Base model filter is now filled from Civitai's live list, so new models (e.g. MiniMax H3) show up without an update. A built-in list is used if Civitai can't be reached.
- Workflows category includes every workflow type Civitai offers (e.g. ComfyUI Workflows), not just "Workflows"
- New categories when Civitai provides them: UNet / Diffusion, Text Encoder, CLIP Vision, downloaded into `diffusion_models`, `text_encoders` and `clip_vision`
- civitai.red support: mature models open on civitai.red, and a setting lets you open every link there

## 1.3.1
- Fixed: LoRAs and other models stored as JSON inside a node's widget value were not detected as missing. This affects any loader that saves its list of models this way (for example multi-LoRA loaders such as AusBoss LoraLoader); all of them are now scanned, including nested lists.
- Download links listed anywhere in a workflow (e.g. model lists in note nodes) are now used as sources
- "Use mine" also works for these nodes

## 1.3.0
- **Missing custom nodes**: Setup now shows which node pack provides each missing node (using ComfyUI-Manager's node list), groups them, and links to each pack
- **Install with Manager** button opens ComfyUI-Manager's missing-packs dialog. The installation itself is done by Manager, which handles the custom_nodes folder, Python dependencies and security checks.
- Fixed: latent upscaler models are now placed in `latent_upscale_models` instead of `upscale_models`

## 1.2.0
- **Use mine**: when a workflow asks for a model you don't have but you own a similar one (newer version, fp8/fp16 or GGUF variant, different folder), Setup offers to re-point the node to your file instead of downloading. One click, with undo.
- Smarter Civitai suggestions: candidates are filtered by type, so a missing VAE no longer suggests checkpoints
- Better folder guessing for GGUF models and custom nodes that register their own model folders

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
