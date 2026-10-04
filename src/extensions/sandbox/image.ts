import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import { getOrThrow } from '@earendil-works/pi-durable/env'

export const createImageTool = () =>
  defineTool({
    name: 'view_image',
    description:
      'View a PNG, JPEG, or WebP image inside the current sandbox, such as a browser screenshot. Returns the image to the model; does not upload it to chat.',
    parameters: Type.Object({ path: Type.String({ description: 'Path inside the sandbox.' }) }),
    async execute({ path }, api, ctx) {
      const bytes = Buffer.from(getOrThrow(await api.env!.readBinaryFile(path, ctx)))
      const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? 'image/jpeg'
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
            ? 'image/webp'
            : undefined
      if (!mimeType) throw new Error('Expected a PNG, JPEG, or WebP image')
      return { content: [{ type: 'image', mimeType, data: bytes.toString('base64') }] }
    }
  })
