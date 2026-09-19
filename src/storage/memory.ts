import type { SQL } from 'bun'
import { withDatabase } from '.'

type Board = { id: string; name: string; description: string; authorSessionId: string; createdAt: string }
type Post = {
  id: string
  boardId: string
  title: string
  body: string
  authorSessionId: string
  createdAt: string
  lastActiveAt: string
}
type Reply = { id: string; postId: string; body: string; authorSessionId: string; createdAt: string }
type Pagination = { limit?: number; offset?: number }

function pagination({ limit = 20, offset = 0 }: Pagination) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid pagination')
  return { limit: Math.min(limit, 100), offset }
}

function page<T>(rows: T[], limit: number) {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit }
}

function required(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
  return value
}

export class MemoryStore {
  constructor(private sql: SQL) {}

  async listBoards(options: Pagination = {}) {
    return withDatabase(this.sql, async () => {
      const { limit, offset } = pagination(options)
      const rows = await this.sql<Board[]>`
        SELECT id, name, description, author_session_id AS "authorSessionId", created_at AS "createdAt"
        FROM memory_boards ORDER BY normalized_name, id LIMIT ${limit + 1} OFFSET ${offset}
      `
      return page(rows, limit)
    })
  }

  async createBoard(name: string, description: string, authorSessionId: string) {
    return withDatabase(this.sql, async () => {
      name = required(name, 'Board name').trim()
      required(description, 'Board description')
      const normalizedName = name.toLowerCase()
      await this.sql`
        INSERT INTO memory_boards (id, name, normalized_name, description, author_session_id, created_at)
        VALUES (${Bun.randomUUIDv7()}, ${name}, ${normalizedName}, ${description}, ${authorSessionId}, ${new Date().toISOString()})
        ON CONFLICT (normalized_name) DO NOTHING
      `
      const [board] = await this.sql<Board[]>`
        SELECT id, name, description, author_session_id AS "authorSessionId", created_at AS "createdAt"
        FROM memory_boards WHERE normalized_name = ${normalizedName}
      `
      return board!
    })
  }

  private async requireBoard(id: string) {
    const [board] = await this.sql`SELECT id FROM memory_boards WHERE id = ${id}`
    if (!board) throw new Error(`Memory board ${id} was not found`)
  }

  private async getPost(id: string) {
    const [post] = await this.sql<Post[]>`
      SELECT id, board_id AS "boardId", title, body, author_session_id AS "authorSessionId",
             created_at AS "createdAt", last_active_at AS "lastActiveAt"
      FROM memory_posts WHERE id = ${id}
    `
    if (!post) throw new Error(`Memory post ${id} was not found`)
    return post
  }

  async createPost(boardId: string, title: string, body: string, authorSessionId: string) {
    return withDatabase(this.sql, async () => {
      required(title, 'Post title')
      required(body, 'Post body')
      await this.requireBoard(boardId)
      const id = Bun.randomUUIDv7()
      const now = new Date().toISOString()
      await this.sql`
        INSERT INTO memory_posts (id, board_id, title, body, author_session_id, created_at, last_active_at)
        VALUES (${id}, ${boardId}, ${title}, ${body}, ${authorSessionId}, ${now}, ${now})
      `
      return this.getPost(id)
    })
  }

  async reply(postId: string, body: string, authorSessionId: string) {
    return withDatabase(this.sql, async () => {
      required(body, 'Reply body')
      await this.getPost(postId)
      return this.sql.begin(async sql => {
        const reply: Reply = { id: Bun.randomUUIDv7(), postId, body, authorSessionId, createdAt: new Date().toISOString() }
        await sql`
          INSERT INTO memory_replies (id, post_id, body, author_session_id, created_at)
          VALUES (${reply.id}, ${postId}, ${body}, ${authorSessionId}, ${reply.createdAt})
        `
        await sql`
          UPDATE memory_posts SET last_active_at = CASE
            WHEN last_active_at < ${reply.createdAt} THEN ${reply.createdAt} ELSE last_active_at END
          WHERE id = ${postId}
        `
        return reply
      })
    })
  }

  async readPost(id: string, options: Pagination = {}) {
    return withDatabase(this.sql, async () => {
      const { limit, offset } = pagination(options)
      const post = await this.getPost(id)
      const replies = await this.sql<Reply[]>`
        SELECT id, post_id AS "postId", body, author_session_id AS "authorSessionId", created_at AS "createdAt"
        FROM memory_replies WHERE post_id = ${id} ORDER BY created_at, id LIMIT ${limit + 1} OFFSET ${offset}
      `
      return { post, replies: page(replies, limit) }
    })
  }

  listPosts(boardId: string, options: Pagination = {}) {
    return this.findPosts('', boardId, options)
  }

  search(query: string, boardId?: string, options: Pagination = {}) {
    return this.findPosts(required(query, 'Search query'), boardId, options)
  }

  private async findPosts(query: string, boardId: string | undefined, options: Pagination) {
    return withDatabase(this.sql, async () => {
      const { limit, offset } = pagination(options)
      if (boardId !== undefined) await this.requireBoard(boardId)
      // Treat LIKE wildcards as literal search text.
      const pattern = `%${query.toLowerCase().replace(/[!%_]/g, '!$&')}%`
      const rows = await this.sql<(Omit<Post, 'body'> & { preview: string })[]>`
        SELECT p.id, p.board_id AS "boardId", p.title, SUBSTR(p.body, 1, 240) AS preview,
               p.author_session_id AS "authorSessionId", p.created_at AS "createdAt", p.last_active_at AS "lastActiveAt"
        FROM memory_posts p
        WHERE (${boardId === undefined} OR p.board_id = ${boardId ?? ''})
          AND (LOWER(p.title) LIKE ${pattern} ESCAPE '!' OR LOWER(p.body) LIKE ${pattern} ESCAPE '!'
            OR EXISTS (SELECT 1 FROM memory_replies r WHERE r.post_id = p.id AND LOWER(r.body) LIKE ${pattern} ESCAPE '!'))
        ORDER BY p.last_active_at DESC, p.id DESC LIMIT ${limit + 1} OFFSET ${offset}
      `
      return page(rows, limit)
    })
  }
}
