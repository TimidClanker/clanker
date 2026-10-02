import type { ImageContent } from '@earendil-works/pi-ai'
import type { Attachment } from 'chat'

export async function downloadImages(attachments: Attachment[]): Promise<ImageContent[]> {
  const images: ImageContent[] = []
  let totalBytes = 0
  for (const attachment of attachments) {
    const mimeType = attachment.mimeType?.split(';')[0]?.toLowerCase() ?? ''
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
      throw new Error('Please send images as PNG, JPEG, WebP, or GIF.')
    }
    if (totalBytes + (attachment.size ?? 0) > 20 * 1024 * 1024) throw new Error('Please keep images under 20 MB total per message.')
    let data = attachment.data
    if (!data) {
      try {
        const downloaded = await attachment.fetchData!()
        data = downloaded instanceof ArrayBuffer ? Buffer.from(downloaded) : downloaded
      } catch {
        throw new Error('I could not download the image. Please attach it again.')
      }
    }
    const bytes = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : data
    totalBytes += bytes.byteLength
    if (totalBytes > 20 * 1024 * 1024) throw new Error('Please keep images under 20 MB total per message.')
    images.push({ type: 'image', mimeType, data: bytes.toString('base64') })
  }
  return images
}
