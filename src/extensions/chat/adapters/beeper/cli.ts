import { mkdir, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import BeeperDesktop from '@beeper/desktop-api'
import { beeperConfig, credentialsPath } from './config'

async function main() {
  const [command, ...accountIDs] = Bun.argv.slice(2)
  const config = await beeperConfig()
  if (command === 'accounts') {
    if (!config.accessToken) throw new Error('Run bun run beeper login first.')
    for (const account of await new BeeperDesktop(config).accounts.list()) {
      console.log(JSON.stringify({ id: account.accountID, network: account.network, user: account.user.fullName }))
    }
    return
  }
  if (command === 'use') {
    if (!accountIDs.length) throw new Error('Usage: bun run beeper use <account-id> [account-id...]')
    const accounts = await new BeeperDesktop(config).accounts.list()
    for (const id of accountIDs) if (!accounts.some(account => account.accountID === id)) throw new Error(`Unknown Beeper account: ${id}`)
    await save({ ...config, accountIDs })
    console.log('Saved Beeper account selection. Set BEEPER_ENABLED=true to enable the adapter alongside Discord.')
    return
  }
  if (command !== 'login') {
    console.log('Usage: bun run beeper login | accounts | use <account-id> [account-id...]')
    return
  }

  const state = crypto.randomUUID()
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url')
  const callback = Promise.withResolvers<string>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 })
      if (url.searchParams.get('state') !== state) return new Response('Invalid OAuth state', { status: 400 })
      const code = url.searchParams.get('code')
      if (!code) {
        callback.reject(new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'Missing authorization code'))
        return new Response('Beeper authorization failed.', { status: 400 })
      }
      callback.resolve(code)
      return new Response('Beeper authorized. You can close this tab.')
    }
  })
  const timeout = setTimeout(() => callback.reject(new Error('Beeper login timed out. Run the command again.')), 5 * 60_000)
  const redirectURI = `http://127.0.0.1:${server.port}/callback`
  try {
    const registration = await fetch(new URL('/oauth/register', config.baseURL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Clanker', redirect_uris: [redirectURI], scope: 'read write' })
    })
    if (!registration.ok) throw new Error(`Beeper client registration failed: ${registration.status}`)
    const client = (await registration.json()) as { client_id: string; authorization_endpoint: string; token_endpoint: string }
    const url = new URL(client.authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectURI,
      response_type: 'code',
      scope: 'read write',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()
    console.log(`Open this URL to authorize Clanker:\n${url}`)
    const code = await callback.promise
    const response = await fetch(client.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id })
    })
    if (!response.ok) throw new Error(`Beeper token exchange failed: ${response.status}`)
    const token = (await response.json()) as { access_token: string }
    await save({ ...config, accessToken: token.access_token })
    console.log(`Beeper credentials saved to ${credentialsPath}. Run bun run beeper accounts, then bun run beeper use <account-id>.`)
  } finally {
    clearTimeout(timeout)
    await server.stop(true)
  }
}

async function save(config: Awaited<ReturnType<typeof beeperConfig>>) {
  await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 })
  await Bun.write(credentialsPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(credentialsPath, 0o600)
}

if (import.meta.main) await main()
