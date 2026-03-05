import { Client, Databases, ID, Query } from 'node-appwrite';
import crypto from 'crypto';

/**
 * 1. Razorpay Webhook Handler
 * 2. Credit Reset Cron
 */

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID || '699c08a50014cc1ba505';
    const SUB_COLLECTION = 'subscriptions';

    try {
        // Action 1: Razorpay Webhook
        if (req.headers['x-razorpay-signature']) {
            const secret = process.env.RAZORPAY_SECRET;
            const signature = req.headers['x-razorpay-signature'];
            const body = req.body;

            const expectedSignature = crypto
                .createHmac('sha256', secret)
                .update(body)
                .digest('hex');

            if (expectedSignature !== signature) {
                return res.json({ success: false, error: 'Invalid signature' }, 400);
            }

            const event = JSON.parse(body);
            log(`Received Razorpay event: ${event.event}`);

            if (event.event === 'subscription.activated' || event.event === 'payment.captured') {
                const userId = event.payload.payment.entity.notes.userId; // Ensure userId is passed in notes
                const plan = event.payload.payment.entity.notes.plan || 'pro';

                // Find or create subscription
                const existing = await databases.listDocuments(DATABASE_ID, SUB_COLLECTION, [
                    Query.equal('userId', userId)
                ]);

                const subData = {
                    userId,
                    status: 'active',
                    plan,
                    imageCreditsRemaining: plan === 'pro' ? 100 : 20, // Example credit limits
                    updatedAt: new Date().toISOString()
                };

                if (existing.total > 0) {
                    await databases.updateDocument(DATABASE_ID, SUB_COLLECTION, existing.documents[0].$id, subData);
                } else {
                    await databases.createDocument(DATABASE_ID, SUB_COLLECTION, ID.unique(), {
                        ...subData,
                        createdAt: new Date().toISOString()
                    });
                }
            }

            return res.json({ success: true });
        }

        // Action 2: Credit Reset Cron
        if (req.headers['x-appwrite-trigger'] === 'schedule' && req.headers['x-appwrite-event'] === 'daily_reset') {
            log('Running daily credit reset...');

            let cursor = null;
            let documents = [];

            do {
                const queries = [Query.equal('status', 'active'), Query.limit(100)];
                if (cursor) queries.push(Query.after(cursor));

                const response = await databases.listDocuments(DATABASE_ID, SUB_COLLECTION, queries);
                documents = response.documents;

                for (const doc of documents) {
                    const resetCredits = doc.plan === 'pro' ? 10 : 2; // Daily bonus example
                    await databases.updateDocument(DATABASE_ID, SUB_COLLECTION, doc.$id, {
                        imageCreditsRemaining: doc.imageCreditsRemaining + resetCredits
                    });
                }

                if (documents.length > 0) {
                    cursor = documents[documents.length - 1].$id;
                }
            } while (documents.length > 0);

            return res.json({ success: true });
        }

        return res.json({ success: false, error: 'Unknown trigger' }, 400);

    } catch (err) {
        error('Subscription Error: ' + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
