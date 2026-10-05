import { chromium } from 'playwright'
import { rm } from 'node:fs/promises'

const readyPath = '/tmp/clanker-desktop-runtime/browser-ready'
await rm(readyPath, { force: true })
const [width, height] = process.env.DESKTOP_SIZE.split('x').map(Number)
const context = await chromium.launchPersistentContext(`${process.env.DESKTOP_DIR}/profile`, {
  headless: false,
  viewport: null,
  args: [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
    `--window-size=${width - 60},${height - 60}`,
    '--window-position=30,30',
    '--disable-dev-shm-usage',
    '--no-first-run'
  ]
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void context.close())
const closed = new Promise(resolve => context.on('close', resolve))
try {
  const page = context.pages()[0] ?? (await context.newPage())
  if (process.argv[2]) await page.goto(process.argv[2])
  const command = Bun.spawn(['agent-browser', 'get', 'url'], { stdout: 'inherit', stderr: 'inherit', timeout: 15_000 })
  if ((await command.exited) !== 0) throw new Error('Browser tooling failed to connect to Chromium')
  await Bun.write(readyPath, 'ready\n')
  await closed
} finally {
  await rm(readyPath, { force: true })
  // Chromium may already be closed; shut down the daemon without reconnecting.
  await Bun.spawn(['agent-browser', 'close'], {
    env: { ...process.env, AGENT_BROWSER_CDP: undefined },
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: 5_000
  }).exited
  await context.close()
}
