// I WROTE THIS CODE WHILE DRUNK A FEW YEARS AGO SORRY IT'S KINDA UGLY LMAO

import puppeteer from 'puppeteer'
import { MongoClient, ServerApiVersion } from 'mongodb'
import sharp from 'sharp'

const BOARDS = ['b', 'soc', 'r'] as const
const QUERIES = ['cock rate', 'dick rate'] as const
const IMAGE_WIDTH = 64
const IMAGE_HEIGHT = 64

type ThreadId = string
type CockId = string
type Board = (typeof BOARDS)[number]
type Query = (typeof QUERIES)[number]

interface Thread {
  board: Board
  id: ThreadId
  cocks: Cock[]
}

interface Cock {
  id: CockId
  src?: string
  image?: Buffer
  score: number // normalized score
  cummulative_score?: number
  vote_count?: number
}

const imageUrlToImageBuffer = async (url: string): Promise<Buffer | undefined> => {
  try {
    const res = await fetch('https:' + url)
    const image = sharp(await res.arrayBuffer()).resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'fill' }).grayscale()
    return image.toBuffer()
  } catch {
    return undefined
  }
}

const getThreadIds = async (board: Board, query: Query): Promise<ThreadId[]> => {
  const url: string = `https://boards.4chan.org/${board}/catalog#s=${encodeURIComponent(query)}`
  const broswer = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  })
  let threadIds: ThreadId[]

  try {
    const page = await broswer.newPage()
    await page.goto(url, {
      waitUntil: 'domcontentloaded'
    })

    threadIds = await page.evaluate(() => {
      return [...document.querySelectorAll('.thread')].map((element) => {
        const match = element.id.match(/-(\d+)$/)
        if (match == null) return null
        return match[1]
      }).filter((val): val is ThreadId => val != null)
    })
  } finally {
    await broswer.close()
  }

  return threadIds
}

const getCocksFromThread = async (board: Board, threadId: ThreadId): Promise<Cock[]> => {
  const url = `https://boards.4chan.org/${board}/thread/${threadId}`
  const broswer = await puppeteer.launch({
    headless: 'new'
  })
  let cocks: Cock[]

  try {
    const page = await broswer.newPage()
    await page.goto(url, {
      waitUntil: 'domcontentloaded'
    })
    
    cocks = await page.evaluate(() => {
      const cockIdToCock: Map<CockId, Cock> = new Map<CockId, Cock>()
      const postMessages = document.querySelectorAll('blockquote.postMessage')
      
      for (const postMessage of postMessages) {
        // get scores from each individual postMessage
        const cockIdToScore: Map<CockId, number> = new Map<CockId, number>()
        const cockIdStack: CockId[] = []
        let defaultCockId: CockId = ''
        for (const child of postMessage.childNodes) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const cockId = (child as Element).getAttribute('href')?.match(/#p(\d+)$/)
            if (cockId == null) continue
            cockIdStack.push(cockId[1])
            continue
          }

          const scoreMatches = child.textContent?.matchAll(/(-?\d+(?:\.\d+)?)\/(\d+)/g) ?? []
          for (const scoreMatch of Array.from(scoreMatches).reverse()) {
            if (cockIdStack.length === 0 && defaultCockId === '') continue
            
            const score: number = 10 * Math.max(0, Math.min(1, parseFloat(scoreMatch[1]) / parseFloat(scoreMatch[2])))
            if (cockIdStack.length === 0) {
              cockIdToScore.set(defaultCockId, score)
              continue
            }

            defaultCockId = cockIdStack.pop() ?? ''
            cockIdToScore.set(defaultCockId, score)
          }
        }

        // add scores from post message to cockIdToCock
        for (const [cockId, score] of cockIdToScore.entries()) {
          if (cockIdToCock.has(cockId)) {
            const oldCock = cockIdToCock.get(cockId)
            if (oldCock == null) continue
            cockIdToCock.set(cockId, {
              id: cockId,
              image: oldCock.image,
              src: oldCock.src,
              score: (oldCock.cummulative_score ?? 0 + score) / (oldCock.vote_count ?? 0 + 1),
              cummulative_score: oldCock.cummulative_score ?? 0 + score,
              vote_count: oldCock.vote_count ?? 0 + 1,
            })
            continue
          }

          const image_url = document.querySelector(`div#f${cockId} > a`)?.getAttribute('href')
          if (image_url == null) continue

          cockIdToCock.set(cockId, {
            id: cockId,
            src: image_url,
            score,
            cummulative_score: score,
            vote_count: 1
          })
        }
      }
      return Array.from(cockIdToCock.values())
    })
  } finally {
    await broswer.close()
  }

  return cocks
}

const processThread = async (board: Board, threadId: ThreadId): Promise<Thread> => {
  const cocks = (
    await Promise.allSettled(
      (await getCocksFromThread(board, threadId)).map(async (cock) => {
        if (cock.src == null) return null
        const image = await imageUrlToImageBuffer(cock.src)
        if (image == null) return null
        return {
            id: cock.id,
            src: cock.src,
            score: cock.score,
            image
        } as Cock
      })
    )
  ).filter(
    (promiseSettledResult): promiseSettledResult is PromiseFulfilledResult<Cock | null> => promiseSettledResult.status === 'fulfilled'
  ).map(
    (promiseFulfilledResult) => promiseFulfilledResult.value
  ).filter(
    (promiseValue): promiseValue is Cock => promiseValue != null
  )
  return {
    board,
    id: threadId,
    cocks
  }
}

const getAllThreads = async (): Promise<Thread[]> => {
  const allThreads: Thread[] = []

  for (const board of BOARDS) {
    for (const query of QUERIES) {
      const threads: Thread[] = await Promise.all((await getThreadIds(board, query)).map((threadId) => {
        return processThread(board, threadId)
      }))
      allThreads.push(...threads)
    }
  }

  return allThreads
}

const storeAllThreads = async (threads: Thread[], connectionString: string): Promise<void> => {
  const cocks = threads.flatMap(thread => thread.cocks);
  const mongoClient = await new MongoClient(connectionString, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true
    }
  }).connect()

  try {
    const cocksCollection = mongoClient.db('cocks')?.collection<Cock>('4chan')
    if (cocksCollection == null) throw new Error('Could not find collection')
    for (const cock of cocks) {
      await cocksCollection.replaceOne({ id: cock.id }, cock, { upsert: true })
    }
  } finally {
    await mongoClient.close()
  }
}

const main = async () => {
  const uri = process.env.MONGODB_URI
  if (uri == null) {
      throw new Error("No MongoDB connection URI found");
  }

  const allThreads = await getAllThreads()
  console.log(allThreads)
  await storeAllThreads(allThreads, uri)
}

main().catch(console.error)
