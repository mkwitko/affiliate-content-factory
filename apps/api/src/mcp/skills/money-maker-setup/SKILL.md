---
name: money-maker-setup
description: Set up Money Maker from zero - workspace, niches, channels, and provider connections - when the user asks to set up or get_setup_status shows a stage other than done.
version: 1.5.0
---

# Money Maker setup

Trigger this skill when the user says setup/init/configurar MoneyMaker, or when `get_setup_status` shows any stage other than done.

When someone asks "quero começar do zero" or "como conecto?", first explain that setup covers workspace, integrations, niches, and channels. Resolve the next incomplete required stage one at a time; do not make them learn IDs or ask for credentials in chat. After setup, return them to the operator guide and suggest one available first goal.

## Steps

1. Call `get_setup_status(workspaceId)`. Read the ordered stages and each stage's `action`.
2. For the `plugins` stage: the server cannot see which plugins are connected in this ChatGPT conversation, so check it yourself — look at which of the recommended tools (Canva, vidIQ, Hook Layer) and optional tools (Unsplash, Creative Production) are actually callable right now. For each recommended one you cannot call, tell the user to go to Plugins -> search for it -> Connect, and say briefly why it matters: Canva for editable layouts, vidIQ and Hook Layer for attributable research. Never claim a plugin is connected without checking.
3. Take the single stage marked `"next"` and resolve only that one gap. Do not jump ahead to a later stage. After resolving it, call `get_setup_status` again before moving on.
4. Never ask for an API key, token, or password in chat. Post For Me, Mercado Livre, and Canva connections are made by the operator on the dashboard: https://example.com (Integrações). If a stage's action involves a connection, point the user there instead of requesting credentials.
5. The `integrations` stage lists `connections`. Post For Me and Mercado Livre are required. Canva is recommended: without it the operator can still post with plain listing photos, but slides are not editable. If `canva.connected` is false, say so once and offer both options. Editable Canva slides also need the Canva plugin connected in this ChatGPT conversation (see step 2).
6. Bio link: for each Instagram niche, call `list_niches` and give the operator its `bioLinkUrl` to paste once as the Instagram profile link. It opens a storefront page listing every active offer with a published post, newest first, each with a picture and a "Ver no Mercado Livre" button; every button click counts for that offer's post. Feed captions are not clickable, so this is the visitor's way in from the profile.
7. The `automations` stage is `optional`. Setup is complete when every non-optional stage is done; do not hold the operator on `automations`.

## TikTok channel

TikTok publishes through each profile's existing Post For Me connection. First the operator connects the TikTok account inside the matching Post For Me project: Social Media Accounts → Connect an Account → TikTok (one TikTok account per project: Casa, Beleza, Tech). Then call `create_channel(workspaceId, connectionId, kind: "tiktok_video")` with that profile's connectionId, and `kind: "tiktok_photo_post"` for photo carousels. `publish_content` sends approved posts to the TikTok app as drafts; the operator finishes and posts each one in the app. `record_manual_publication` remains for a post made by hand. Once the channel exists, call `record_tiktok_shop_status(workspaceId, channelId, state, …)` with whatever the operator reports from the in-app checklist (Perfil → menu → TikTok Studio → "TikTok Shop para criadores") and whether the profile shows a bio link, so the operator skill's TikTok section can route the account strategy; hand off to money-maker-operator for that.

## Image rules (non-negotiable)

- A real Mercado Livre product photo is always the base of any product image.
- Canva is for layout only.
- Unsplash is only for backgrounds or scenes that do not depict the product itself.
- Creative Production, or any generated image, must never alter or invent the product.
- Never invent product facts, prices, discounts, or reviews.

## When setup looks complete

Once every non-optional stage is `"done"` (plugins stays unavailable and is verified manually; automations is optional), hand off to the money-maker-operator skill for day-to-day content and publication work.
