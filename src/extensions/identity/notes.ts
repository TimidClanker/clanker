import type { Context } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import { defineDoc, defineTool, type ConversationId, type DocumentReader, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { findIdentity, getIdentity, getParticipants, type PlatformAccount } from 'extensions/identity/state'

export type IdentityAccess = {
  /** A freshly verified one-to-one chat recipient; null for groups or unsupported adapters. */
  privateAccount(read: DocumentReader, conversationId: ConversationId, ctx: Context): Promise<PlatformAccount | null>
}

type Note = { identityId: string; visibility: 'public' | 'private'; text: string; createdAt: string; updatedAt: string }
const Notes = defineDoc<{ notes: Record<string, Note> }>({
  kind: 'identity.notes',
  version: 1,
  scope: 'session',
  initial: () => ({ notes: {} })
})
const NoteChange = defineDoc<{ noteId?: string }>({ kind: 'identity.note-change', version: 1, scope: 'task', initial: () => ({}) })
const visibility = Type.Union([Type.Literal('public'), Type.Literal('private')])
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

async function noteAccess(read: DocumentReader, conversationId: ConversationId, identityId: string, access: IdentityAccess, ctx: Context) {
  const identity = await getIdentity(read, identityId, ctx)
  if (!(await getParticipants(read, conversationId, ctx)).some(author => author.identityId === identity.id)) {
    throw new Error('User has not been observed in this conversation')
  }
  const account = await access.privateAccount(read, conversationId, ctx).catch(error => {
    console.warn('[identity] Unable to verify private chat', error)
    return null
  })
  ctx.abortSignal?.throwIfAborted()
  const privateAvailable = account !== null && (await findIdentity(read, account, ctx)) === identity.id
  return {
    identityId: identity.id,
    privateAvailable,
    visible: (note: Note) =>
      (note.identityId === identity.id || identity.aliases.includes(note.identityId)) && (note.visibility === 'public' || privateAvailable)
  }
}

async function getUserNotes(read: DocumentReader, conversationId: ConversationId, identityId: string, access: IdentityAccess, ctx: Context) {
  const scope = await noteAccess(read, conversationId, identityId, access, ctx)
  const notes = Object.entries((await read.snapshot(Notes, ctx))?.notes ?? {})
    .filter(([, note]) => scope.visible(note))
    .map(([id, { identityId: _owner, ...note }]) => ({ id, ...note }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return { identityId: scope.identityId, privateAvailable: scope.privateAvailable, notes }
}

export function createNoteTools(access: IdentityAccess) {
  const changeNote = async (
    api: ToolExecutionApi,
    ctx: Context,
    identityId: string,
    noteId: string | undefined,
    change?: { visibility: Note['visibility']; text: string }
  ) => {
    const scope = await noteAccess(api, api.conversationId, identityId, access, ctx)
    if (change?.visibility === 'private' && !scope.privateAvailable) throw new Error('Private notes require a verified one-to-one chat with their owner')
    if (change && !change.text.trim()) throw new Error('Note text must not be blank')
    return api.commit(async tx => {
      // Save the receipt atomically with the mutation, so replay never duplicates or restores an outdated note.
      const receipt = await tx.doc(NoteChange, api.taskId)
      if (receipt.noteId) return receipt.noteId
      const { notes } = await tx.doc(Notes)
      const previous = noteId !== undefined && Object.hasOwn(notes, noteId) ? notes[noteId] : undefined
      if (noteId !== undefined && (!previous || !scope.visible(previous))) throw new Error('Note not found or not accessible')
      if (previous && change && previous.visibility !== change.visibility && !scope.privateAvailable) {
        throw new Error('Changing note visibility requires a verified one-to-one chat with its owner')
      }
      const id = noteId ?? crypto.randomUUID()
      if (change) {
        const now = new Date().toISOString()
        notes[id] = {
          identityId: scope.identityId,
          visibility: change.visibility,
          text: change.text.trim(),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now
        }
      } else {
        delete notes[id]
      }
      receipt.noteId = id
      return id
    }, ctx)
  }

  return [
    defineTool({
      name: 'read_user_notes',
      description:
        'Read saved memories about an observed participant. Public notes are available across conversations. Private notes are returned only in a verified one-to-one chat with that identity, including linked accounts. privateAvailable describes access, not whether hidden notes exist. Results are newest first.',
      parameters: Type.Object({
        identityId: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 }))
      }),
      replay: 'safe',
      outputLimits: { maxBytes: 200_000 },
      execute: async ({ identityId, offset = 0, limit = 20 }, api, ctx) => {
        const { notes, ...scope } = await getUserNotes(api, api.conversationId, identityId, access, ctx)
        return result({ ...scope, notes: notes.slice(offset, offset + limit), nextOffset: offset + limit < notes.length ? offset + limit : null })
      }
    }),
    defineTool({
      name: 'save_user_note',
      description:
        'Save a concise factual memory about an observed participant. Supply noteId to update an existing note. Choose visibility explicitly: public means shareable across conversations; private requires a verified one-to-one chat with the owner. Changing visibility also requires that private chat. Read existing notes first to avoid duplicates and replace outdated facts.',
      parameters: Type.Object({
        identityId: Type.String({ minLength: 1 }),
        noteId: Type.Optional(Type.String({ minLength: 1 })),
        visibility,
        text: Type.String({ minLength: 1, maxLength: 2000 })
      }),
      replay: 'safe',
      executionMode: 'sequential',
      execute: async ({ identityId, noteId, visibility, text }, api, ctx) =>
        result({ noteId: await changeNote(api, ctx, identityId, noteId, { visibility, text }) })
    }),
    defineTool({
      name: 'delete_user_note',
      description: 'Delete a saved memory by noteId. Private notes can only be deleted in a verified one-to-one chat with their owner.',
      parameters: Type.Object({ identityId: Type.String({ minLength: 1 }), noteId: Type.String({ minLength: 1 }) }),
      replay: 'safe',
      executionMode: 'sequential',
      execute: async ({ identityId, noteId }, api, ctx) => result({ deleted: await changeNote(api, ctx, identityId, noteId) })
    })
  ]
}
