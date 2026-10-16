---
name: money-maker-pending
description: Resolve unfinished Money Maker posts - list drafts, variants awaiting approval, approved but unpublished variants, and unsettled publications, then finish, re-sync, or cancel each one with the operator.
version: 1.9.0
---

# Money Maker pending work

Trigger this skill when the operator says `pendências`, `pendentes`, `inacabados`, `resolver`, or asks to finish or clean up posts.

When asked "o que está pendente?", summarize counts by approval, processing, retryable failure, and old draft before listing actionable items. Resolve names and states from `list_pending_content`; show an ID only when needed to distinguish choices or resume later. Recommend exactly the next safe action per item and keep the state-specific rules below.

## Steps

1. Call get_setup_status(workspaceId). If `structure` or `integrations` is not `done`, hand off to the money-maker-setup skill and end the turn.
2. Call list_pending_content(workspaceId). Before showing anything, call reconcile_publication once for each item whose `nextAction` is `reconcile`, with its attempt's attemptId; leave PUBLICATION_STILL_UNKNOWN items as they are and note the server keeps checking. Then call list_pending_content again for the refreshed states. Show a numbered list, newest first. For each item show the channel name (or "no channel yet" for `kind: "content_item"`), offer title, state, attempt status when present, `nextAction`, the slide count (`assetCount`), the `editUrl` when present, and the full caption quoted. If the list is empty, say so and end the turn.
3. Ask which numbers to handle. Whenever a step below calls preview_content, pass only the workspaceId and variantId; the server derives evidence age and destination fingerprint from the offer. For each item the operator picks, follow its `nextAction`:
   - Text edits before approval (`muda o título do slide 2 para ...`, `troca o texto do slide 4`, `ajusta a legenda do Instagram`): call edit_creative_copy(workspaceId, contentItemId, slides: [{index, headline?, body?}] and/or captions: [{variantId, caption}]). Pass only the text the owner dictated; never edit the price, discount badge, link, CTA or `#publi` (the system adds the CTA and `#publi` itself and fills the badge from verified facts). Numbers need a verified offer fact. The slides re-render from the same scenes and any Reel is re-rendered; poll list_pending_content until `creativeRender.state` is `rendered`, then show preview_content again and ask for `aprova`. A post that is already approved, scheduled or published is refused (`CONTENT_ALREADY_APPROVED` / `VARIANT_NOT_EDITABLE`): tell the owner to reject or cancel it first. Editing never approves or publishes anything.
   - `approve`: call preview_content and show the post as it will look: every slide as an inline image `![Slide <n>](<slides[n].url>)`, then the full caption. Ask for `aprova`. Only after `aprova`: approve_content, then publish_content(contentVariantId: <variantId>, idempotencyKey: "publish:<variantId>"), then get_publication_status with the returned attemptId.
   - `publish`: the variant is already approved but not published. Show the caption and slide count from preview_content and ask for `aprova`; only then call publish_content(contentVariantId: <variantId>, idempotencyKey: "publish:<variantId>") and get_publication_status. When the item's attempt ended in `permanent_failure`, use idempotencyKey: "publish:<variantId>:<failed attemptId>" instead, so a new attempt is created.
   - `manual_story`: an approved instagram_stories variant not yet posted by hand. Call get_story_kit(workspaceId, variantId) and show: each slide as an inline image link to save (`![Slide <n>](<slides[n].url>)`), the official `affiliateUrl` in its own code block, then the steps: salvar as imagens → Instagram → novo Story → imagem → adesivo "Link" → colar o link → texto "Ver oferta" → publicar → responder `postei stories`. When the operator answers `postei stories`, call record_manual_publication(workspaceId, variantId).
   - TikTok (`tiktok_video`, `tiktok_photo_post`): `publish` sends a draft to the TikTok app. After publishing, show the approved caption in a code block and the product to attach from preview_content's `tiktokShop` field when present, then tell the operator to open the TikTok draft notification, attach that product if shown, and post.
   - Package items (title starts with `Pacote `): the operator already approved the whole package; do not ask again. A `Dor` item with an approved carousel continues at money-maker-package step 6.2 (render its Reel, schedule it, cancel the source carousel); never publish that carousel. A `TikTok` item continues at step 6.3.
   - `reconcile`: still unresolved after the automatic reconcile_publication call in step 2. Call it again with the attemptId and report the result; if the provider still has no answer, say the server keeps checking and move on.
   - `wait`: the worker is still publishing. Report the status and move on; never call publish_content again for it.
   - `build`: a post (`kind: "content_item"`) that stopped before any usable variant, for example after an interrupted Canva export or while waiting for generated slides. Hand off to the money-maker-operator skill at "Build the post" with its existing contentItemId and offerId, so research and the affiliate link are not repeated; when the operator attaches slides, import them as that skill describes. Ask which channels to build for when the operator did not say.
   - `rebuild`: the variant was rejected. Hand off to the money-maker-operator skill at "Build the post" with the same offer and channel; once the new variant exists, call cancel_content for the rejected one with the reason "replaced by <new variantId>".
   When the operator answers `sincroniza <n>` for an item with a `design`, follow the `sincroniza` steps of the money-maker-operator skill for that variant.
4. When the operator says `cancela <n> <motivo>`: call cancel_content with the reason and that item's variantId, or its contentItemId when the item is `kind: "content_item"`. If it returns PUBLICATION_STILL_UNKNOWN, run `reconcile` for the item first and ask again. Report the result.
5. After handling the picked items, call list_pending_content again and show what is left. End the turn.

## Rules

- Never publish without the operator's `aprova` for the exact preview shown last.
- Never cancel without an explicit `cancela` naming the item.
- If a tool call fails, stop and quote the error code and message; do not retry with different inputs on your own.
- Cancelling keeps the record and its assets; nothing is deleted.
