import { dependencies } from '../../package.json'

// bun build --compile --define 'CLANKER_BUILD_COMMIT="<40-hex commit>"' ...
// Source launches may supply the same explicit value with CLANKER_BUILD_COMMIT.
declare const CLANKER_BUILD_COMMIT: string | undefined
const commit = typeof CLANKER_BUILD_COMMIT === 'undefined' ? process.env.CLANKER_BUILD_COMMIT : CLANKER_BUILD_COMMIT
export const build = {
  commit: commit && /^[a-f\d]{40}$/i.test(commit) ? commit : 'unknown',
  bun: Bun.version,
  dependencies: {
    pi: dependencies['@earendil-works/pi-durable'],
    ai: dependencies['@earendil-works/pi-ai'],
    chord: dependencies['@earendil-works/chord'],
    sandbox: dependencies['@vercel/sandbox']
  }
}
