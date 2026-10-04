# Media generation

The agent discovers authenticated backends with `list_media_backends`, then calls `generate_image` with a listed `backend`, `model`, and a text `prompt`. Backend selection is independent of the conversation's `MODEL`. There is no longer a single `IMAGE_MODEL` setting.

| Backend        | Authentication                                             | Image models                     |
| -------------- | ---------------------------------------------------------- | -------------------------------- |
| `openai-codex` | `bun run login openai-codex`                               | `gpt-image-2`                    |
| `openrouter`   | `bun run login openrouter api_key` or `OPENROUTER_API_KEY` | Pi AI's OpenRouter image catalog |

Both backends can be available at once. Discovery resolves credentials through Pi AI, including OAuth refresh, and excludes missing credentials, failed refreshes, and malformed Codex tokens. Generation checks availability again, so logging out removes access even if the agent previously listed the backend. A failed auth lookup for one backend does not hide the other. Availability means credentials can be resolved; it does not probe every model, validate an API key remotely, or guarantee remaining quota and account entitlements. Provider errors are returned to the agent without silently switching backends.

OpenRouter uses Pi AI's `generateImages()`. Codex uses Bun `fetch` against `https://chatgpt.com/backend-api/codex/images/generations`, following the [Codex image client](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs) and its subscription authentication. Pi AI resolves and refreshes the Codex token; the adapter supplies the account header. This subscription endpoint is not Pi AI's image API and may change upstream.

Backends implement `MediaBackend` in `providers/index.ts`: identity, model catalog, auth availability, and generation. Register implementations in `src/index.ts`. The extension owns listing, model validation, the shared agent tools, cancellation, and delivery. Backends do not import Chat SDK or other extensions.

Generated images are sent to the current conversation through Chat SDK. Image bytes are persisted in the existing chat-post task, whose upload retries reuse those bytes. Images are not written to a shared host directory or placed in the model's text context.

Generation has a five-minute timeout and is unsafe to replay: a crash during the provider call does not automatically repeat a potentially billed request. Once queued, image delivery resumes with the other durable chat tasks. As with text posts, a crash after the platform accepts an upload but before its checkpoint commits can duplicate the post.

This version supports text-to-image creation. Editing, reference images, and video are not exposed yet.
