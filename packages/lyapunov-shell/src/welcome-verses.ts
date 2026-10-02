/** 官网公开水墨短句，原库未标作者；仅离线使用，不声称后端诗词API。 */
export const welcomeVerses = [
  {
    "id": "vorynel-ink-short-0",
    "text": "山高水长，云淡风轻",
    "author": null,
    "sourceTitle": "官网水墨飘字库·短联",
    "sourceURL": "https://vorynel.com/assets/InkDriftBackground-96_Ff8K6.js",
    "verified": true,
    "verification": "anonymous-public-asset-exact-text",
    "quoteKind": "website-phrase"
  },
  {
    "id": "vorynel-ink-short-1",
    "text": "月白风清，山静水流",
    "author": null,
    "sourceTitle": "官网水墨飘字库·短联",
    "sourceURL": "https://vorynel.com/assets/InkDriftBackground-96_Ff8K6.js",
    "verified": true,
    "verification": "anonymous-public-asset-exact-text",
    "quoteKind": "website-phrase"
  },
  {
    "id": "vorynel-ink-short-4",
    "text": "心如止水，意若行云",
    "author": null,
    "sourceTitle": "官网水墨飘字库·短联",
    "sourceURL": "https://vorynel.com/assets/InkDriftBackground-96_Ff8K6.js",
    "verified": true,
    "verification": "anonymous-public-asset-exact-text",
    "quoteKind": "website-phrase"
  },
  {
    "id": "vorynel-ink-short-8",
    "text": "静水流深，磐石不移",
    "author": null,
    "sourceTitle": "官网水墨飘字库·短联",
    "sourceURL": "https://vorynel.com/assets/InkDriftBackground-96_Ff8K6.js",
    "verified": true,
    "verification": "anonymous-public-asset-exact-text",
    "quoteKind": "website-phrase"
  }
] as const

export function createWelcomeVerseStore(random: () => number = Math.random) {
 const visited = new Map<string, (typeof welcomeVerses)[number]>()
 let previous: string | undefined
 return { get(entryKey: string) {
  const stored=visited.get(entryKey);if(stored)return stored
  const candidates=welcomeVerses.filter(verse=>verse.id!==previous)
  const sample=random();const index=Number.isFinite(sample)?Math.min(candidates.length-1,Math.max(0,Math.floor(sample*candidates.length))):0
  const verse=candidates[index]!;visited.set(entryKey,verse);previous=verse.id;return verse
 }}
}
