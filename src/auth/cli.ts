import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { credentials, models } from './store'
import { modelSelection } from '../model'

async function main() {
  const [command, providerId = modelSelection.split('/')[0]!, method] = Bun.argv.slice(2)
  if (!command || command === '--help' || command === 'help') {
    console.log(`Usage:
  bun run login [provider] [oauth|api_key]
  bun run auth list
  bun run auth logout <provider>

Examples:
  bun run login openai              Sign in with ChatGPT
  bun run login openai-codex        Codex subscription (browser or device code)
  bun run login openrouter api_key  Save an OpenRouter API key

Credentials: ${credentials.path}
Set MODEL=provider/model[:reasoning] in .env, for example openai-codex/gpt-6-astra:low.
For headless OAuth, use device code when offered, or paste the final browser redirect URL.
Mount the secrets directory as a writable persistent volume in containers.`)
    return
  }
  if (command === 'list') {
    const stored = new Map((await credentials.list()).map(entry => [entry.providerId, entry.type]))
    for (const provider of models.getProviders()) {
      const methods = [provider.auth.oauth && 'oauth', provider.auth.apiKey?.login && 'api_key'].filter(Boolean)
      console.log(`${provider.id}: ${methods.join(', ') || 'environment credentials'}${stored.has(provider.id) ? ` (saved: ${stored.get(provider.id)})` : ''}`)
    }
    return
  }
  const provider = models.getProviders().find(provider => provider.id === providerId)
  if (!provider) throw new Error(`Unknown provider: ${providerId}. Run bun run auth list.`)
  if (command === 'logout') {
    await models.logout(providerId)
    console.log(`Removed saved credentials for ${providerId}. Environment credentials are unaffected.`)
    return
  }
  if (command !== 'login') throw new Error('Unknown command. Run bun run auth --help.')
  const type = method ?? (provider.auth.oauth ? 'oauth' : 'api_key')
  if (type !== 'oauth' && type !== 'api_key') throw new Error('Login method must be oauth or api_key.')
  if (!(type === 'oauth' ? provider.auth.oauth : provider.auth.apiKey?.login)) {
    throw new Error(`${providerId} does not offer ${type} login. Run bun run auth list.`)
  }

  const controller = new AbortController()
  let hidden = false
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk)
      callback()
    }
  })
  const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY, historySize: 0 })
  const cancel = () => controller.abort(new Error('Login cancelled'))
  rl.on('SIGINT', cancel)
  rl.on('close', cancel)
  process.once('SIGTERM', cancel)
  try {
    await models.login(
      providerId,
      type,
      {
        signal: controller.signal,
        async prompt(prompt) {
          console.log(prompt.message)
          if (prompt.type === 'select') {
            prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`))
          }
          process.stdout.write('> ')
          hidden = prompt.type === 'secret' || prompt.type === 'manual_code'
          try {
            const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal
            const answer = (await rl.question('', { signal })).trim()
            if (prompt.type !== 'select') return answer
            const option = prompt.options.find(option => option.id === answer) ?? prompt.options[Number(answer) - 1]
            if (!option) throw new Error('Invalid selection')
            return option.id
          } finally {
            if (hidden) process.stdout.write('\n')
            hidden = false
          }
        },
        notify(event) {
          if (event.type === 'auth_url') console.log(`Open: ${event.url}\n${event.instructions ?? ''}`)
          else if (event.type === 'device_code') console.log(`Open: ${event.verificationUri}\nCode: ${event.userCode}`)
          else {
            console.log(event.message)
            if (event.type === 'info') event.links?.forEach(link => console.log(`${link.label ?? 'More information'}: ${link.url}`))
          }
        }
      },
      { getDeviceId: credentials.getDeviceId }
    )
    console.log(`Saved ${providerId} credentials to ${credentials.path}`)
    console.log(`To use this provider, set MODEL=${providerId}/<model-id>:low in .env. Login does not change model selection.`)
  } finally {
    rl.close()
    process.off('SIGTERM', cancel)
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Authentication failed')
    process.exitCode = 1
  })
}
