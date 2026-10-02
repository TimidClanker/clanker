import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { models } from './auth'

export const modelSelection = process.env.MODEL ?? `${process.env.MODEL_PROVIDER ?? 'openai'}/${process.env.MODEL_ID ?? 'gpt-5.6-sol'}`

export function selectModel(selection: string) {
  const slash = selection.indexOf('/')
  if (slash < 1) throw new Error('Use MODEL=provider/model[:reasoning], for example openai-codex/gpt-6-astra:low')
  const provider = selection.slice(0, slash)
  const id = selection.slice(slash + 1)
  // Preserve provider model IDs containing slashes or suffixes such as :free.
  let model = models.getModel(provider, id)
  let thinkingLevel: ModelThinkingLevel = 'low'
  if (!model) {
    const suffix = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/.exec(id)
    if (suffix) {
      model = models.getModel(provider, suffix[1]!)
      thinkingLevel = suffix[2] as ModelThinkingLevel
    }
  }
  if (!model) throw new Error(`Unknown model selection: ${selection}. Use provider/model[:off|minimal|low|medium|high|xhigh|max].`)
  return { model, thinkingLevel }
}
