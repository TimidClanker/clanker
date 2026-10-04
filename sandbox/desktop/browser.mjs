import { chromium } from 'playwright'

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
const page = context.pages()[0] ?? (await context.newPage())
if (process.argv[2]) await page.goto(process.argv[2])
await closed
