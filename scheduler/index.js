import { Client, Databases, ID, Query, Functions } from 'node-appwrite';

/**
 * Scheduler Functions:
 * 1. schedulePost: API to save post
 * 2. cronScheduler: Polling mechanism
 */

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const functions = new Functions(client);

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const POSTS_COLLECTION = 'scheduled_posts';
    const PUBLISHER_FUNCTION_ID = 'publisher_function'; // Update with actual ID

    const userId = req.headers['x-appwrite-user-id'];

    try {
        const payload = JSON.parse(req.body || '{}');

        // Action 1: Create Scheduled Post (from Frontend)
        if (payload.action === 'schedule') {
            if (!userId) return res.json({ success: false, error: 'Unauthorized' }, 401);

            const { content, mediaFileId, platform, scheduledFor } = payload;

            const post = await databases.createDocument(DATABASE_ID, POSTS_COLLECTION, ID.unique(), {
                userId,
                content,
                mediaFileId,
                platform,
                scheduledFor, // ISO String
                status: 'pending',
                createdAt: new Date().toISOString()
            });

            return res.json({ success: true, data: post });
        }

        // Action 2: Cron Job Execution (Polling)
        // This part is triggered by Appwrite Cron every 1 minute
        if (req.headers['x-appwrite-trigger'] === 'schedule') {
            log('Polling for pending posts...');

            const now = new Date().toISOString();
            const pendingPosts = await databases.listDocuments(DATABASE_ID, POSTS_COLLECTION, [
                Query.equal('status', 'pending'),
                Query.lessThanEqual('scheduledFor', now),
                Query.limit(10) // Process in batches
            ]);

            log(`Found ${pendingPosts.total} posts to publish`);

            for (const post of pendingPosts.documents) {
                // Trigger the publisher function asynchronously
                functions.createExecution(PUBLISHER_FUNCTION_ID, JSON.stringify(post), true);

                // Mark as 'in-progress' to avoid double publishing
                await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, post.$id, {
                    status: 'processing'
                });
            }

            return res.json({ success: true, count: pendingPosts.total });
        }

        return res.json({ success: false, error: 'Invalid action or trigger' }, 400);

    } catch (err) {
        error('Scheduler Error: ' + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
