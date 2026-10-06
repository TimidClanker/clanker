import { resolve } from 'node:path'

export const credentialsPath = resolve(process.env.SECRETS_DIR ?? './secrets', 'beeper.json')

export async function beeperConfig() {
  const file = Bun.file(credentialsPath)
  const saved: { baseURL?: string; accessToken?: string; accountIDs?: string[] } = (await file.exists()) ? await file.json() : {}
  return {
    baseURL: process.env.BEEPER_BASE_URL || saved.baseURL || 'http://localhost:23373',
    accessToken: process.env.BEEPER_ACCESS_TOKEN || saved.accessToken,
    accountIDs:
      process.env.BEEPER_ACCOUNT_IDS?.split(',')
        .map(id => id.trim())
        .filter(Boolean) ??
      saved.accountIDs ??
      []
  }
}
