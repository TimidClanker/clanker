import type { SQL, TransactionSQL } from 'bun'
import { withDatabase } from '.'

export interface ConnectionIdentity {
  adapter: string
  platformUserId: string
}

export class UserStore {
  constructor(private sql: SQL) {}

  private async find(sql: SQL | TransactionSQL, identity: ConnectionIdentity) {
    const [user] = await sql<{ id: string; createdAt: string }[]>`
      SELECT u.id, u.created_at AS "createdAt" FROM users u
      JOIN user_connections c ON c.user_id = u.id
      WHERE c.adapter = ${identity.adapter} AND c.platform_user_id = ${identity.platformUserId}
    `
    return user ?? null
  }

  resolve(identity: ConnectionIdentity) {
    return withDatabase(this.sql, () => this.find(this.sql, identity))
  }

  private async connect(sql: TransactionSQL, userId: string, identity: ConnectionIdentity) {
    await sql`
      INSERT INTO user_connections (id, user_id, adapter, platform_user_id, created_at)
      VALUES (${Bun.randomUUIDv7()}, ${userId}, ${identity.adapter}, ${identity.platformUserId}, ${new Date().toISOString()})
    `
    await sql`
      UPDATE sessions SET user_id = ${userId}
      WHERE adapter = ${identity.adapter} AND owner_id = ${identity.platformUserId} AND user_id IS NULL
    `
  }

  enroll(identity: ConnectionIdentity) {
    return withDatabase(this.sql, () =>
      this.sql.begin(async sql => {
        const existing = await this.find(sql, identity)
        if (existing) return existing
        const user = { id: Bun.randomUUIDv7(), createdAt: new Date().toISOString() }
        await sql`INSERT INTO users (id, created_at) VALUES (${user.id}, ${user.createdAt})`
        await this.connect(sql, user.id, identity)
        return user
      })
    )
  }

  connections(userId: string) {
    return withDatabase(
      this.sql,
      () => this.sql<
        {
          id: string
          adapter: string
          platformUserId: string
          createdAt: string
        }[]
      >`
      SELECT id, adapter, platform_user_id AS "platformUserId", created_at AS "createdAt"
      FROM user_connections WHERE user_id = ${userId} ORDER BY created_at, id
    `
    )
  }

  async issueLink(userId: string) {
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const hash = new Bun.CryptoHasher('sha256').update(code).digest('hex')
    await withDatabase(
      this.sql,
      () => this.sql`
      INSERT INTO user_link_tokens (hash, user_id, expires_at) VALUES (${hash}, ${userId}, ${expiresAt})
    `
    )
    return { code, expiresAt }
  }

  redeemLink(identity: ConnectionIdentity, code: string) {
    const hash = new Bun.CryptoHasher('sha256').update(code.trim()).digest('hex')
    return withDatabase(this.sql, () =>
      this.sql.begin(async sql => {
        if (await this.find(sql, identity)) throw new Error('This account is already connected to a user')
        const [token] = await sql<{ user_id: string }[]>`
        DELETE FROM user_link_tokens WHERE hash = ${hash} AND expires_at > ${new Date().toISOString()} RETURNING user_id
      `
        if (!token) throw new Error('The linking code is invalid, expired, or already used')
        await this.connect(sql, token.user_id, identity)
        return (await this.find(sql, identity))!
      })
    )
  }
}
