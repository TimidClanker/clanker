import type { Models } from '@earendil-works/pi-ai'
import type { MediaBackend } from 'extensions/media-gen/providers'

export class OpenAICodex implements MediaBackend {
  readonly name = 'openai-codex'
  readonly description = 'OpenAI image generation through the signed-in Codex subscription. Subject to account image limits.'
  readonly models = [{ id: 'gpt-image-2', name: 'GPT Image 2' }]

  constructor(private ai: Models) {}

  private async auth(signal?: AbortSignal) {
    const resolved = await this.ai.getAuth(this.name, { signal })
    const token = resolved?.auth.apiKey
    if (!token) return
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id
    if (!accountId) throw new Error('Codex credentials are missing the ChatGPT account ID. Sign in again.')
    return { token, accountId }
  }

  async isAvailable(signal?: AbortSignal) {
    return Boolean(await this.auth(signal))
  }

  async generate({ model, prompt }: { model: string; prompt: string }, signal?: AbortSignal) {
    const auth = await this.auth(signal)
    if (!auth) throw new Error('Codex is not authenticated. Run bun run login openai-codex.')
    // Matches Codex's standalone image client; Pi AI does not implement this image API yet.
    const response = await fetch('https://chatgpt.com/backend-api/codex/images/generations', {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'ChatGPT-Account-ID': auth.accountId,
        'Content-Type': 'application/json',
        originator: 'pi',
        'x-codex-image-turn-id': crypto.randomUUID()
      },
      body: JSON.stringify({ model, prompt, background: 'opaque', quality: 'auto', size: 'auto' })
    })
    if (!response.ok) throw new Error(`Codex image generation failed (${response.status}): ${(await response.text()).slice(0, 2000)}`)
    const result = (await response.json()) as { data: { b64_json: string }[]; output_format?: string }
    const mimeType = `image/${result.output_format === 'jpg' ? 'jpeg' : (result.output_format ?? 'png')}`
    return { output: result.data.map(image => ({ type: 'image' as const, data: image.b64_json, mimeType })) }
  }
}
