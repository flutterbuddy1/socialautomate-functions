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
            const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
            const signature = req.headers['x-razorpay-signature'];
            const body = req.body;

            const expectedSignature = crypto
                .createHmac('sha256', secret)
                .update(body)
                .digest('hex');

            if (expectedSignature !== signature) {
                error('Signature mismatch');
                return res.json({ success: false, error: 'Invalid signature' }, 400);
            }

            const event = JSON.parse(body);
            log(`Received Razorpay event: ${event.event}`);

            const validEvents = ['subscription.activated', 'payment.captured', 'order.paid'];
            if (validEvents.includes(event.event)) {
                // Determine source entity
                const entity = event.payload.payment?.entity || event.payload.order?.entity || event.payload.subscription?.entity;
                
                if (!entity || !entity.notes || !entity.notes.userId) {
                    error('No userId found in payment notes');
                    return res.json({ success: false, error: 'Missing userId in notes' }, 400);
                }

                const userId = entity.notes.userId;
                const plan = entity.notes.plan || 'monthly';

                // Find or create subscription
                const existing = await databases.listDocuments(DATABASE_ID, SUB_COLLECTION, [
                    Query.equal('userId', userId)
                ]);

                const now = new Date();
                let endDate = null;
                if (plan === 'free_trial') {
                    endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
                } else if (plan === 'monthly') {
                    endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
                } else if (plan === '6_months') {
                    endDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
                } else if (plan === 'yearly') {
                    endDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
                }

                const subData = {
                    userId,
                    isActive: "true",
                    plan,
                    imageCreditsRemaining: (['monthly', '6_months', 'yearly'].includes(plan) ? 5 : 3).toString(),
                    startDate: now.toISOString(),
                    lastCreditReset: now.toISOString(),
                    endDate: endDate,
                };

                if (existing.total > 0) {
                    log(`Updating existing subscription ${existing.documents[0].$id}`);
                    await databases.updateDocument(DATABASE_ID, SUB_COLLECTION, existing.documents[0].$id, subData);
                } else {
                    log('Creating new subscription document');
                    await databases.createDocument(DATABASE_ID, SUB_COLLECTION, ID.unique(), subData);
                }
                log('Subscription updated successfully');
            } else {
                log(`Ignored event: ${event.event}`);
            }

            return res.json({ success: true });
        }

        // Action 2: Credit Reset & Trial Expiry Cron
        if (req.headers['x-appwrite-trigger'] === 'schedule') {
            log('Running subscription maintenance cron...');

            let cursor = null;
            let documents = [];

            do {
                const queries = [Query.equal('isActive', "true"), Query.limit(100)];
                if (cursor) queries.push(Query.after(cursor));

                const response = await databases.listDocuments(DATABASE_ID, SUB_COLLECTION, queries);
                documents = response.documents;

                for (const doc of documents) {
                    const now = new Date();

                    // 1. Check Trial Expiry
                    if (doc.plan === 'free_trial' && doc.endDate) {
                        const expiry = new Date(doc.endDate);
                        if (now > expiry) {
                            log(`Expiring trial for user ${doc.userId}`);
                            await databases.updateDocument(DATABASE_ID, SUB_COLLECTION, doc.$id, {
                                isActive: "false"
                            });
                            continue;
                        }
                    }

                    // 2. Daily Reset for Paid Plans
                    if (['monthly', '6_months', 'yearly'].includes(doc.plan) && doc.isActive === "true") {
                        const lastReset = new Date(doc.lastCreditReset || doc.startDate);
                        
                        // Check if a day has passed
                        if (now.getDate() !== lastReset.getDate() || now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
                            log(`Daily credit reset for user ${doc.userId} (${doc.plan})`);
                            await databases.updateDocument(DATABASE_ID, SUB_COLLECTION, doc.$id, {
                                imageCreditsRemaining: "5",
                                lastCreditReset: now.toISOString()
                            });
                        }
                    }
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
