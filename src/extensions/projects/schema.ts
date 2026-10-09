import { Type } from '@earendil-works/pi-ai'

const id = Type.String({ minLength: 1, maxLength: 100 })

export type ProjectScope = { projectId: string; workItemIds?: string[] }[]
export const projectScopeSchema = Type.Array(
  Type.Object({ projectId: id, workItemIds: Type.Optional(Type.Array(id, { maxItems: 20, uniqueItems: true })) }, { additionalProperties: false }),
  { maxItems: 8 }
)
