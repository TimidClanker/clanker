import { join } from 'node:path'

export async function databaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim()
  const file = Bun.file(join(process.env.SECRETS_DIR ?? './secrets', 'database.json'))
  const saved: { url?: string } = (await file.exists()) ? await file.json() : {}
  return saved.url?.trim() || 'sqlite://./workspace/durable.sqlite'
}

export function isPostgresUrl(url: string) {
  return /^postgres(?:ql)?:\/\//i.test(url)
}
