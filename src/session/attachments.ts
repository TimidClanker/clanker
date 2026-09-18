import { resolve } from 'node:path'
import { resizeImage } from '@earendil-works/pi-coding-agent'
import type { Message } from 'chat'

export function describeAttachments(message: Message) {
  return message.attachments.map(attachment => ({
    name: attachment.name ?? null,
    type: attachment.type,
    mimeType: attachment.mimeType ?? null,
    size: attachment.size ?? null
  }))
}

export async function prepareAttachments(message: Message, signal: AbortSignal) {
  const directory = resolve('workspace/attachments', new Bun.CryptoHasher('sha256').update(JSON.stringify([message.threadId, message.id])).digest('hex'))
  const attachments = await Promise.all(
    message.attachments.map(async (attachment, index) => {
      signal.throwIfAborted()
      let data = attachment.data ?? (await attachment.fetchData?.())
      if (!data && attachment.url) {
        const response = await fetch(attachment.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
        if (!response.ok) throw new Error(`Unable to download attachment ${attachment.name ?? index + 1}: HTTP ${response.status}`)
        data = await response.blob()
      }
      if (!data) throw new Error(`Attachment ${attachment.name ?? index + 1} has no downloadable data`)
      signal.throwIfAborted()
      const name = attachment.name || `attachment-${index + 1}`
      const path = resolve(directory, `${index + 1}-${name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160)}`)
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data instanceof Blob ? await data.arrayBuffer() : data)
      await Bun.write(path, bytes)
      const mimeType = (attachment.mimeType || (data instanceof Blob && data.type) || Bun.file(path).type).split(';')[0]!.trim().toLowerCase()
      const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType) ? await resizeImage(bytes, mimeType) : undefined
      return { name, path, mimeType, size: bytes.length, image }
    })
  )
  signal.throwIfAborted()
  return {
    files: attachments.map(({ image, ...file }) => ({ ...file, inlineImage: !!image })),
    images: attachments.flatMap(({ image }) => (image ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : []))
  }
}
