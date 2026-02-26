import { Client, Databases, Query } from 'node-appwrite';
import axios from 'axios';

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    const DATABASE_ID = process.env.DATABASE_ID;
    const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
    const ENDPOINT = process.env.APPWRITE_ENDPOINT;
    const ACCOUNTS_COLLECTION = 'connected_accounts';
    const POSTS_COLLECTION = 'scheduled_posts';
    const BUCKET_ID = '699ea200000d168a2f64';

    /**
     * Step 1: Create function publishInstagramPost(post)
     */
    async function publishInstagramPost(post) {
        log(`[Instagram] Publishing post ${post.$id}...`);

        // 1. Fetch connected account
        const accounts = await databases.listDocuments(DATABASE_ID, ACCOUNTS_COLLECTION, [
            Query.equal('userId', post.userId),
            Query.equal('platform', 'instagram')
        ]);

        if (accounts.total === 0) {
            throw new Error(`No connected Instagram account found for user ${post.userId}`);
        }

        const account = accounts.documents[0];
        const accessToken = account.accessToken;
        const instagramBusinessId = account.pageId; // User's proven field name for business id

        if (!instagramBusinessId) {
            throw new Error('instagramBusinessId (pageId) is missing for the connected account.');
        }

        // 2. Convert imageFileId to public URL
        // From user logic: https://cloud.appwrite.io/v1/storage/buckets/BUCKET_ID/files/{imageFileId}/view?project=PROJECT_ID
        // We use the ENDPOINT from env which should include /v1
        const imageUrl = `${ENDPOINT}/storage/buckets/${BUCKET_ID}/files/${post.imageField}/view?project=${PROJECT_ID}`;
        log(`[Instagram] Image URL: ${imageUrl}`);

        // 3. Create media container
        const containerRes = await axios.post(
            `https://graph.facebook.com/v19.0/${instagramBusinessId}/media`,
            {
                image_url: imageUrl,
                caption: post.content,
                access_token: accessToken
            }
        );

        const creation_id = containerRes.data.id;
        log(`[Instagram] Media container created: ${creation_id}`);

        // 4. Publish media
        await axios.post(
            `https://graph.facebook.com/v19.0/${instagramBusinessId}/media_publish`,
            {
                creation_id: creation_id,
                access_token: accessToken
            }
        );

        log(`[Instagram] Post ${post.$id} published successfully.`);

        // 5. Update scheduled_posts status
        await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, post.$id, {
            status: 'published'
        });
    }

    try {
        log('Step 2: Starting cron function...');
        const now = new Date().toISOString();

        // Query scheduled_posts where: platform = "instagram", status = "pending", scheduledAt <= current_time
        const pendingPosts = await databases.listDocuments(DATABASE_ID, POSTS_COLLECTION, [
            Query.equal('platform', 'instagram'),
            Query.equal('status', 'pending'),
            Query.lessThanEqual('scheduledAt', now)
        ]);

        log(`Found ${pendingPosts.total} posts to process.`);

        // Loop through posts
        for (const post of pendingPosts.documents) {
            try {
                // Call publishInstagramPost(post)
                await publishInstagramPost(post);
            } catch (postErr) {
                // Step 3: Error handling
                const errorMsg = postErr.response ? JSON.stringify(postErr.response.data) : postErr.message;
                error(`[Error] Post ${post.$id}: ${errorMsg}`);

                await databases.updateDocument(DATABASE_ID, POSTS_COLLECTION, post.$id, {
                    status: 'failed'
                });
            }
        }

        return res.json({ success: true, processed: pendingPosts.total });

    } catch (err) {
        error('Global Publisher Error: ' + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};
