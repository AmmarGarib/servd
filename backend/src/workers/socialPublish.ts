import { Worker, Queue } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { publishInstagramPost, publishFacebookPost } from '../lib/meta-social.js'

const QUEUE_NAME = 'social-publish'

const queue = new Queue(QUEUE_NAME, { connection: redis })

export function startSocialPublishWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Both 'publish' and 'poll' jobs land on this queue; only the dedicated
      // pollerWorker below handles 'poll'. Bail otherwise to avoid crashing
      // on the empty data payload.
      if (job.name !== 'publish') return
      const { postId } = job.data as { postId: string }
      const post = await prisma.socialPost.findUnique({ where: { id: postId } })
      if (!post || post.status !== 'scheduled') return

      try {
        let platformPostId: string
        if (post.platform === 'instagram') {
          platformPostId = await publishInstagramPost(post.caption, post.mediaUrls)
        } else if (post.platform === 'facebook') {
          platformPostId = await publishFacebookPost(post.caption, post.mediaUrls)
        } else {
          throw new Error(`Unsupported platform: ${post.platform}`)
        }

        await prisma.socialPost.update({
          where: { id: postId },
          data:  { status: 'published', publishedAt: new Date(), platformPostId },
        })
        await prisma.contentEvent.update({
          where: { id: post.eventId },
          data:  { status: 'live' },
        })
      } catch (err) {
        await prisma.socialPost.update({
          where: { id: postId },
          data:  { status: 'failed', error: (err as Error).message },
        })
      }
    },
    { connection: redis, concurrency: 2 },
  )

  worker.on('failed', (job, err) => {
    console.error(`[social-publish] job ${job?.id} failed:`, err.message)
  })

  // Poll every minute for posts due to publish
  queue.upsertJobScheduler(
    'poll-due-social-posts',
    { pattern: '* * * * *' },
    { name: 'poll', data: {}, opts: { removeOnComplete: 5, removeOnFail: 5 } },
  ).catch(() => { /* non-critical */ })

  // The poller job itself uses a special name handled below
  const pollerWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== 'poll') return
      const duePosts = await prisma.socialPost.findMany({
        where: { status: 'scheduled', scheduledFor: { lte: new Date() } },
        select: { id: true },
      })
      for (const post of duePosts) {
        await queue.add('publish', { postId: post.id }, { removeOnComplete: 10, removeOnFail: 20 })
      }
    },
    { connection: redis, concurrency: 1 },
  )

  pollerWorker.on('failed', (job, err) => {
    console.error(`[social-publish] poller failed:`, err.message)
  })

  console.log('[social-publish] worker started')
}
