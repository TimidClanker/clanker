import type { Thread } from 'chat'

export function showTyping(thread: Thread) {
  let pending = false
  const send = async () => {
    if (pending) return
    pending = true
    try {
      await thread.startTyping()
    } catch (error) {
      console.warn('[clanker] Typing indicator failed', error)
    } finally {
      pending = false
    }
  }
  void send()
  const timer = setInterval(send, 8000)
  timer.unref()
  return { [Symbol.dispose]: () => clearInterval(timer) }
}
